// Plan 5, Task 9. `renderToStaticMarkup` under Node, same convention as
// test/web-render.test.ts: this file is `.ts`, not `.tsx` — every element is
// built with `createElement`, never JSX syntax. Every component under test
// is pure (callbacks as props, no router, no fetch), which is what makes
// this possible.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FlightList } from '../web/components/FlightList.js'
import { FlightCard, stopsWords, durationWords, timeHM, dayOffset } from '../web/components/FlightCard.js'
import { HotelList, ratingStars } from '../web/components/HotelList.js'
import { ChoiceCard } from '../web/components/ChoiceCard.js'
import { FilterChips } from '../web/components/FilterChips.js'
import { PinnedSummary } from '../web/components/PinnedSummary.js'
import { ResultsPane } from '../web/components/ResultsPane.js'
import { SummaryBar, summarySegments, nightsBetween } from '../web/components/SummaryBar.js'
import { MessageBubble } from '../web/components/MessageBubble.js'
import { applyFilterLite } from '../web/filters.js'
import type { ResultItemLite, ResultsView, ProposalRowLite, LinkLite } from '../web/data.js'

const NOW = new Date('2026-11-18T09:00:00.000Z')

const FLIGHT_ITEM: ResultItemLite = {
  sourceId: 'F1', name: 'Qatar Airways', priceMinor: '84500', currency: 'EUR',
  fetchedAt: '2026-11-18T08:50:00.000Z', ttlSeconds: 900,
  flight: {
    outbound: {
      from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00',
      via: ['DOH'], viaCities: ['Doha'], carriers: ['QR'], carrierNames: ['Qatar Airways'],
      durationMinutes: 855,
    },
    inbound: null,
    stops: 1,
    inboundStops: null,
    durationMinutes: 855,
    airlines: ['QR'],
    airlineNames: ['Qatar Airways'],
    bags: { personal: 1, cabin: 1, checked: 1 },
    selfTransfer: false,
  },
}

const HOTEL_ITEM: ResultItemLite = {
  sourceId: 'H1', name: 'Hotel Gracery', priceMinor: '112000', currency: 'EUR',
  fetchedAt: '2026-11-18T08:50:00.000Z', ttlSeconds: 900,
  hotel: { rating: 4, nights: 7, checkIn: '2026-11-19', checkOut: '2026-11-26' },
}

const INBOUND_LEG = {
  from: 'HND', to: 'BCN', departureLocal: '2026-12-06T11:00:00', arrivalLocal: '2026-12-06T22:30:00',
  via: [], viaCities: [], carriers: ['QR'], carrierNames: ['Qatar Airways'], durationMinutes: 690,
}

describe('FlightCard', () => {
  it('renders the leg row: times over codes, the duration, the stop cities and the airline logo', () => {
    const html = renderToStaticMarkup(
      createElement(FlightCard, { item: FLIGHT_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('Outbound')
    expect(html).toContain('07:05')
    expect(html).toContain('BCN')
    expect(html).toContain('10:20')
    expect(html).toContain('HND')
    expect(html).toContain('14h 15m')
    // The CITY, never the bare airport code, is what the stops line says.
    expect(html).toContain('1 stop, Doha')
    expect(html).not.toContain('1 stop, DOH')
    // The logo is the Kiwi CDN url with the airline NAME as its alt text.
    expect(html).toContain('https://images.kiwi.com/airlines/64/QR.png')
    expect(html).toContain('alt="Qatar Airways"')
  })

  it('marks a next-day arrival with a superscript day offset', () => {
    const html = renderToStaticMarkup(
      createElement(FlightCard, { item: FLIGHT_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('<sup class="leg-day-offset">+1</sup>')
  })

  it('renders no Inbound row for a one-way, and one for a return', () => {
    const oneWay = renderToStaticMarkup(
      createElement(FlightCard, { item: FLIGHT_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(oneWay).not.toContain('Inbound')

    const roundTrip = renderToStaticMarkup(createElement(FlightCard, {
      item: { ...FLIGHT_ITEM, flight: { ...FLIGHT_ITEM.flight!, inbound: INBOUND_LEG, inboundStops: 0 } },
      adults: 2, now: NOW, onChoose: () => {},
    }))
    expect(roundTrip).toContain('Inbound')
    expect(roundTrip).toContain('11h 30m')
    expect(roundTrip).toContain('Direct')
  })

  it('shows the price, the party size, a Select button and the fetched age', () => {
    const html = renderToStaticMarkup(
      createElement(FlightCard, { item: FLIGHT_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('€845.00')
    expect(html).toContain('for 2 passengers')
    expect(html).toContain('Select')
    expect(html).toContain('found 10 min ago')
  })

  it('says "for 1 passenger" in the singular', () => {
    const html = renderToStaticMarkup(
      createElement(FlightCard, { item: FLIGHT_ITEM, adults: 1, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('for 1 passenger')
  })

  it('renders all three bag counts, dimming the ones that are not included', () => {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      item: { ...FLIGHT_ITEM, flight: { ...FLIGHT_ITEM.flight!, bags: { personal: 1, cabin: 1, checked: 0 } } },
      adults: 2, now: NOW, onChoose: () => {},
    }))
    expect([...html.matchAll(/class="flight-bag"/g)]).toHaveLength(3)
    expect([...html.matchAll(/data-included="false"/g)]).toHaveLength(1)
  })

  it('warns about a self-transfer itinerary', () => {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      item: { ...FLIGHT_ITEM, flight: { ...FLIGHT_ITEM.flight!, selfTransfer: true } },
      adults: 2, now: NOW, onChoose: () => {},
    }))
    expect(html).toContain('Self-transfer')
  })

  it('renders a chosen card with a Selected ribbon and no button', () => {
    const html = renderToStaticMarkup(
      createElement(FlightCard, { item: FLIGHT_ITEM, adults: 2, now: NOW, chosen: true, onChoose: () => {} }),
    )
    expect(html).toContain('data-chosen="true"')
    expect(html).toContain('Selected')
    expect(html).not.toContain('<button')
  })

  it('renders nothing at all for an item with no flight payload', () => {
    const html = renderToStaticMarkup(
      createElement(FlightCard, { item: HOTEL_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toBe('')
  })
})

describe('FlightList', () => {
  it('drops a non-flight item silently rather than rendering a broken row', () => {
    const html = renderToStaticMarkup(
      createElement(FlightList, { items: [HOTEL_ITEM], adults: 1, now: NOW, onChoose: () => {} }),
    )
    expect(html).not.toContain('Hotel Gracery')
  })

  it('a nonstop filter reduces the rendered cards', () => {
    const items = [
      FLIGHT_ITEM,
      { ...FLIGHT_ITEM, sourceId: 'F2', flight: { ...FLIGHT_ITEM.flight!, stops: 0 } },
    ]
    const full = renderToStaticMarkup(createElement(FlightList, { items, adults: 1, now: NOW, onChoose: () => {} }))
    const filtered = renderToStaticMarkup(
      createElement(FlightList, { items: applyFilterLite(items, { nonstop: true }), adults: 1, now: NOW, onChoose: () => {} }),
    )
    const countCards = (html: string) => [...html.matchAll(/class="flight-card"/g)].length
    expect(countCards(filtered)).toBeLessThan(countCards(full))
    expect(countCards(filtered)).toBe(1)
  })
})

describe('timeHM / dayOffset / stopsWords / durationWords', () => {
  it('reads the hour and minute straight off a naive ISO local time', () => {
    expect(timeHM('2026-11-19T07:05:00')).toBe('07:05')
    expect(timeHM('not a time')).toBe('--:--')
  })

  it('counts whole calendar days between two naive date-times', () => {
    expect(dayOffset('2026-11-19T07:05:00', '2026-11-20T10:20:00')).toBe(1)
    expect(dayOffset('2026-11-19T07:00:00', '2026-11-19T08:00:00')).toBe(0)
  })

  it('stopsWords: Direct, "1 stop, City", "N stops, City, City"', () => {
    expect(stopsWords(0, [])).toBe('Direct')
    expect(stopsWords(1, ['Doha'])).toBe('1 stop, Doha')
    expect(stopsWords(1, [])).toBe('1 stop')
    expect(stopsWords(2, ['Doha', 'Istanbul'])).toBe('2 stops, Doha, Istanbul')
  })

  it('durationWords formats minutes as "Hh Mm"', () => {
    expect(durationWords(855)).toBe('14h 15m')
    expect(durationWords(60)).toBe('1h 0m')
    expect(durationWords(45)).toBe('0h 45m')
  })
})

describe('HotelList', () => {
  it('renders name, stars, nights, dates, price, age and a Choose button', () => {
    const html = renderToStaticMarkup(
      createElement(HotelList, { items: [HOTEL_ITEM], now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('Hotel Gracery')
    expect(html).toContain('★★★★')
    expect(html).toContain('7 nights')
    expect(html).toContain('2026-11-19')
    expect(html).toContain('2026-11-26')
    expect(html).toContain('€1,120.00')
    expect(html).toMatch(/Choose/)
  })

  it('renders a chosen hotel pinned, with no Choose button', () => {
    const html = renderToStaticMarkup(
      createElement(HotelList, { items: [HOTEL_ITEM], now: NOW, chosenSourceId: 'H1', onChoose: () => {} }),
    )
    expect(html).toContain('Chosen')
    expect(html).not.toContain('<button')
  })
})

describe('ratingStars', () => {
  it('renders the right number of stars', () => {
    expect(ratingStars(4)).toBe('★★★★')
    expect(ratingStars(5)).toBe('★★★★★')
  })

  it('renders "Unrated" for null', () => {
    expect(ratingStars(null)).toBe('Unrated')
  })
})

describe('ChoiceCard', () => {
  it('renders the question and one btn-ghost button per option', () => {
    const html = renderToStaticMarkup(
      createElement(ChoiceCard, {
        question: 'Which city did you mean?',
        options: [{ id: 'TYO', label: 'Tokyo' }, { id: 'OSA', label: 'Osaka' }],
        onPick: () => {},
      }),
    )
    expect(html).toContain('Which city did you mean?')
    expect(html).toContain('Tokyo')
    expect(html).toContain('Osaka')
    expect([...html.matchAll(/btn-ghost/g)]).toHaveLength(2)
  })
})

describe('FilterChips', () => {
  const items: ResultItemLite[] = [
    FLIGHT_ITEM,
    { ...FLIGHT_ITEM, sourceId: 'F2', priceMinor: '20000', flight: { ...FLIGHT_ITEM.flight!, airlines: ['LH'] } },
  ]

  it('renders a chip per airline and a price cap select', () => {
    const html = renderToStaticMarkup(createElement(FilterChips, { items, filter: {}, onChange: () => {} }))
    expect(html).toContain('QR')
    expect(html).toContain('LH')
    expect(html).toContain('<select')
    expect(html).toContain('Nonstop')
    expect(html).toContain('Up to 1 stop')
  })

  it('marks the active chip aria-pressed="true"', () => {
    const html = renderToStaticMarkup(createElement(FilterChips, { items, filter: { nonstop: true }, onChange: () => {} }))
    expect(html).toMatch(/aria-pressed="true"[^]*?>Nonstop</)
  })
})

describe('PinnedSummary', () => {
  const items = [
    { slot: 'outbound', sourceId: 'F1', kind: 'flight' as const, name: 'BCN→HND', priceMinor: '84500', currency: 'EUR', fetchedAt: NOW.toISOString(), dates: '2026-11-19' },
  ]

  it('shows chosen items, the total, and Get booking links while undecided', () => {
    const html = renderToStaticMarkup(
      createElement(PinnedSummary, {
        items, totalMinor: '84500', currency: 'EUR', decision: null, links: [],
        pending: false, error: null, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('BCN→HND')
    expect(html).toContain('€845.00')
    expect(html).toContain('Get booking links')
    expect(html).not.toContain('<a ')
  })

  it('shows only the links once accepted — no Get booking links button', () => {
    const links: LinkLite[] = [{ itemId: 'F1', url: 'https://mock.example/book/F1?gt_ref=abc', quotedMinor: '84500', currency: 'EUR' }]
    const html = renderToStaticMarkup(
      createElement(PinnedSummary, {
        items, totalMinor: '84500', currency: 'EUR', decision: 'accept', links,
        pending: false, error: null, onGetLinks: () => {},
      }),
    )
    const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual([links[0]!.url])
    expect(html).not.toContain('Get booking links')
  })
})

function proposal(overrides: Partial<ProposalRowLite & { links: LinkLite[] }> = {}): ProposalRowLite & { links: LinkLite[] } {
  return {
    id: 'p1', totalMinor: '84500', currency: 'EUR', gateOutcome: 'approved', reviewIssues: [],
    decision: null,
    items: [{ slot: 'outbound', sourceId: 'F1', kind: 'flight', name: 'BCN→HND', priceMinor: '84500', currency: 'EUR', fetchedAt: NOW.toISOString(), dates: '2026-11-19' }],
    links: [],
    ...overrides,
  }
}

function resultsView(overrides: Partial<ResultsView> = {}): ResultsView {
  return {
    messageId: 'm1', kind: 'flights',
    query: { from: 'BCN', to: 'HND', outbound: '2026-11-19', inbound: null, adults: 1 },
    assumptions: [], filter: undefined, items: [FLIGHT_ITEM],
    cityNames: { BCN: 'Barcelona', HND: 'Tokyo' },
    ...overrides,
  }
}

describe('SummaryBar', () => {
  const FLIGHT_QUERY = {
    from: 'BCN', to: 'HND', outbound: '2026-11-19', inbound: '2026-12-06',
    adults: 2, cabin: 'premium_economy' as const,
  }
  const CITIES = { BCN: 'Barcelona', HND: 'Tokyo' }

  it('builds the flight segments from the query, with weekdays computed from the ISO dates', () => {
    expect(summarySegments('flights', FLIGHT_QUERY, CITIES)).toEqual([
      'Barcelona BCN → Tokyo HND',
      'Thu 19 Nov to Sun 6 Dec',
      '2 adults',
      'Premium economy',
    ])
  })

  it('says "one way" instead of a return date for a one-way query', () => {
    expect(summarySegments('flights', { ...FLIGHT_QUERY, inbound: null }, CITIES)[1]).toBe('Thu 19 Nov, one way')
  })

  it('falls back to the bare code for a place the table does not know', () => {
    expect(summarySegments('flights', FLIGHT_QUERY, {})[0]).toBe('BCN BCN → HND HND')
  })

  it('builds the hotel segments with the night count and no cabin', () => {
    expect(summarySegments('hotels', { place: 'Tokyo', outbound: '2026-11-20', inbound: '2026-12-06', adults: 2 }, {})).toEqual([
      'Tokyo',
      '20 Nov to 6 Dec',
      '16 nights',
      '2 adults',
    ])
  })

  it('counts nights in UTC, never the viewer\'s own timezone', () => {
    expect(nightsBetween('2026-11-20', '2026-12-06')).toBe(16)
    expect(nightsBetween('2026-11-20', '2026-11-21')).toBe(1)
  })

  it('renders the assumptions as one muted sentence, not one chip each', () => {
    const html = renderToStaticMarkup(createElement(SummaryBar, {
      kind: 'flights', query: FLIGHT_QUERY, cityNames: CITIES,
      assumptions: [
        { field: 'year', value: '2026', reason: 'year' },
        { field: 'outbound', value: '2026-11-19', reason: 'defaulted' },
      ],
    }))
    expect(html).toContain('Assumed: the year 2026, and leaving on the 19th to arrive by the 20th.')
    expect([...html.matchAll(/summary-assumed/g)]).toHaveLength(1)
  })

  it('prints no assumption line at all when nothing was assumed', () => {
    const html = renderToStaticMarkup(createElement(SummaryBar, {
      kind: 'flights', query: FLIGHT_QUERY, cityNames: CITIES, assumptions: [],
    }))
    expect(html).not.toContain('summary-assumed')
    expect(html).not.toContain('Assumed')
  })
})

describe('ResultsPane', () => {
  it('shows the summary bar with the assumption sentence above the list', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView({ assumptions: [{ field: 'year', value: '2026', reason: 'year' }] })],
        proposal: null, now: NOW, pending: false, error: null, onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('Barcelona BCN → Tokyo HND')
    expect(html).toContain('Assumed: the year 2026.')
    expect(html).not.toContain('assumption-chip')
  })

  it('shows the pinned summary only once something is chosen', () => {
    const noneChosen = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: null, now: NOW, pending: false, error: null,
        onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(noneChosen).not.toContain('pinned-summary')

    const chosen = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: proposal(), now: NOW, pending: false, error: null,
        onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(chosen).toContain('pinned-summary')
    expect(chosen).toContain('Get booking links')
  })

  it('renders the newest hotels list above the newest flights list', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView({ messageId: 'm1', kind: 'flights', items: [FLIGHT_ITEM] }), resultsView({ messageId: 'm2', kind: 'hotels', items: [HOTEL_ITEM] })],
        proposal: null, now: NOW, pending: false, error: null, onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    // A flight card renders no supplier `name` field at all (an itinerary has no single name
    // the way a hotel does), so it is identified by the card's own class.
    const hotelIndex = html.indexOf('Hotel Gracery')
    const flightIndex = html.indexOf('flight-card')
    expect(hotelIndex).toBeGreaterThan(-1)
    expect(flightIndex).toBeGreaterThan(-1)
    expect(hotelIndex).toBeLessThan(flightIndex)
  })

  it('calls onChoose with the kind and sourceId when a Select button exists', () => {
    const onChoose = vi.fn()
    // Can't simulate a click under renderToStaticMarkup; this just pins that
    // the callback wiring compiles and the row renders with it attached.
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: null, now: NOW, pending: false, error: null, onChoose, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('Select')
  })
})

  // M4: `ResultsPane` ignored `ResultsView.filter`, so after a TYPED filter the chips rendered
  // unselected while the list below them was narrowed — two stories about the same list.
  it('starts the chips from the results row\'s own filter, and narrows the list to match', () => {
    const nonstopItem: ResultItemLite = {
      ...FLIGHT_ITEM, sourceId: 'F0',
      flight: { ...FLIGHT_ITEM.flight!, stops: 0 },
    }
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView({ filter: { nonstop: true }, items: [nonstopItem, FLIGHT_ITEM] })],
        proposal: null, now: NOW, pending: false, error: null, onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    // The Nonstop chip is pressed...
    expect(html).toContain('aria-pressed="true"')
    expect(/aria-pressed="true"[^>]*>\s*Nonstop/.test(html)).toBe(true)
    // ...and FLIGHT_ITEM (one stop, via Doha) is filtered out of the list below it, leaving only
    // the direct card. Source ids are not rendered, so the cards are counted and the excluded
    // item is identified by its own stops line.
    expect(html.match(/class="flight-card"/g)).toHaveLength(1)
    expect(html).toContain('>Direct<')
    expect(html).not.toContain('1 stop, Doha')
  })

  it('leaves every chip unpressed when the row carries no filter', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: null, now: NOW, pending: false, error: null,
        onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(html).not.toContain('aria-pressed="true"')
  })

describe('MessageBubble (plan 5 roles)', () => {
  it('renders a results marker row with the message-action styling hook', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'results', content: '10 flights shown' }))
    expect(html).toContain('10 flights shown')
    expect(html).toContain('message-action')
  })

  it('renders a choices row through ChoiceCard, inert when no conversationId is given', () => {
    const content = JSON.stringify({
      questionId: 'destination', question: 'Which city did you mean?',
      options: [{ id: 'TYO', label: 'Tokyo' }, { id: 'OSA', label: 'Osaka' }],
    })
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'choices', content }))
    expect(html).toContain('Which city did you mean?')
    expect(html).toContain('Tokyo')
    expect(html).toContain('Osaka')
    expect(html).toContain('btn-ghost')
  })

  it('falls back to a fixed sentence for a malformed choices row, never the raw JSON', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'choices', content: 'not json' }))
    expect(html).toContain('A question was recorded')
    expect(html).not.toContain('not json')
  })

  it('escapes a supplier name containing a script tag as plain text, never markup', () => {
    const html = renderToStaticMarkup(
      createElement(HotelList, {
        items: [{ ...HOTEL_ITEM, name: '<script>alert(1)</script>' }],
        now: NOW, onChoose: () => {},
      }),
    )
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })
})
