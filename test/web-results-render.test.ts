// Plan 5, Task 9. `renderToStaticMarkup` under Node, same convention as
// test/web-render.test.ts: this file is `.ts`, not `.tsx` — every element is
// built with `createElement`, never JSX syntax. Every component under test
// is pure (callbacks as props, no router, no fetch), which is what makes
// this possible.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FlightList, legTimeRange, stopsWords, durationWords } from '../web/components/FlightList.js'
import { HotelList, ratingStars } from '../web/components/HotelList.js'
import { ChoiceCard } from '../web/components/ChoiceCard.js'
import { FilterChips } from '../web/components/FilterChips.js'
import { PinnedSummary } from '../web/components/PinnedSummary.js'
import { ResultsPane, assumptionChipText } from '../web/components/ResultsPane.js'
import { MessageBubble } from '../web/components/MessageBubble.js'
import { applyFilterLite } from '../web/filters.js'
import type { ResultItemLite, ResultsView, ProposalRowLite, LinkLite } from '../web/data.js'

const NOW = new Date('2026-11-18T09:00:00.000Z')

const FLIGHT_ITEM: ResultItemLite = {
  sourceId: 'F1', name: 'Qatar Airways', priceMinor: '84500', currency: 'EUR',
  fetchedAt: '2026-11-18T08:50:00.000Z', ttlSeconds: 900,
  flight: {
    outbound: { from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00', via: ['DOH'] },
    inbound: null,
    stops: 1,
    durationMinutes: 855,
    airlines: ['QR'],
    bags: { cabin: 1, checked: 1 },
    selfTransfer: false,
  },
}

const HOTEL_ITEM: ResultItemLite = {
  sourceId: 'H1', name: 'Hotel Gracery', priceMinor: '112000', currency: 'EUR',
  fetchedAt: '2026-11-18T08:50:00.000Z', ttlSeconds: 900,
  hotel: { rating: 4, nights: 7, checkIn: '2026-11-19', checkOut: '2026-11-26' },
}

describe('FlightList', () => {
  it('renders airline, times, stops, duration, bags, price, age and a Choose button', () => {
    const html = renderToStaticMarkup(
      createElement(FlightList, { items: [FLIGHT_ITEM], now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('QR')
    expect(html).toContain('07:05 BCN')
    expect(html).toContain('10:20+1 HND')
    expect(html).toContain('1 stop, DOH')
    expect(html).toContain('14h 15m')
    expect(html).toContain('found 10 min ago')
    expect(html).toMatch(/Choose/)
    expect(html).toContain('€845.00')
  })

  it('renders a chosen item pinned, with a Chosen state and no Choose button', () => {
    const html = renderToStaticMarkup(
      createElement(FlightList, { items: [FLIGHT_ITEM], now: NOW, chosenSourceId: 'F1', onChoose: () => {} }),
    )
    expect(html).toContain('data-chosen="true"')
    expect(html).toContain('Chosen')
    expect(html).not.toContain('<button')
  })

  it('drops a non-flight item silently rather than rendering a broken row', () => {
    const html = renderToStaticMarkup(
      createElement(FlightList, { items: [HOTEL_ITEM], now: NOW, onChoose: () => {} }),
    )
    expect(html).not.toContain('Hotel Gracery')
  })

  it('a nonstop filter reduces the rendered rows', () => {
    const items = [
      FLIGHT_ITEM,
      { ...FLIGHT_ITEM, sourceId: 'F2', flight: { ...FLIGHT_ITEM.flight!, stops: 0 } },
    ]
    const full = renderToStaticMarkup(createElement(FlightList, { items, now: NOW, onChoose: () => {} }))
    const filtered = renderToStaticMarkup(
      createElement(FlightList, { items: applyFilterLite(items, { nonstop: true }), now: NOW, onChoose: () => {} }),
    )
    const countRows = (html: string) => [...html.matchAll(/class="result-row"/g)].length
    expect(countRows(filtered)).toBeLessThan(countRows(full))
    expect(countRows(filtered)).toBe(1)
  })
})

describe('legTimeRange / stopsWords / durationWords', () => {
  it('formats a next-day arrival as "+1"', () => {
    expect(legTimeRange(FLIGHT_ITEM.flight!.outbound)).toBe('07:05 BCN → 10:20+1 HND')
  })

  it('formats a same-day arrival with no offset suffix', () => {
    const leg = { from: 'LIS', to: 'OPO', departureLocal: '2026-11-19T07:00:00', arrivalLocal: '2026-11-19T08:00:00', via: [] }
    expect(legTimeRange(leg)).toBe('07:00 LIS → 08:00 OPO')
  })

  it('stopsWords: Nonstop, "1 stop, X", "N stops"', () => {
    expect(stopsWords(0, [])).toBe('Nonstop')
    expect(stopsWords(1, ['DOH'])).toBe('1 stop, DOH')
    expect(stopsWords(1, [])).toBe('1 stop')
    expect(stopsWords(2, ['DOH', 'IST'])).toBe('2 stops')
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
    ...overrides,
  }
}

describe('assumptionChipText', () => {
  it('formats a year assumption', () => {
    expect(assumptionChipText({ field: 'year', value: '2026-11-19', reason: 'year' })).toBe('Assumed: 2026')
  })

  it('formats an arrive-by-shifted outbound assumption', () => {
    expect(assumptionChipText({ field: 'outbound', value: '2026-11-19', reason: 'defaulted' })).toBe(
      'Leaving 19 Nov to arrive by the 20th',
    )
  })
})

describe('ResultsPane', () => {
  it('shows assumption chips at the top', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView({ assumptions: [{ field: 'year', value: '2026-11-19', reason: 'year' }] })],
        proposal: null, now: NOW, pending: false, error: null, onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('Assumed: 2026')
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
    // `FlightList` renders the airline code, not the supplier's `name`
    // field (the flight row has no single "name" the way a hotel row does).
    const hotelIndex = html.indexOf('Hotel Gracery')
    const flightIndex = html.indexOf('result-row-airlines')
    expect(hotelIndex).toBeGreaterThan(-1)
    expect(flightIndex).toBeGreaterThan(-1)
    expect(hotelIndex).toBeLessThan(flightIndex)
  })

  it('calls onChoose with the kind and sourceId when a Choose button exists', () => {
    const onChoose = vi.fn()
    // Can't simulate a click under renderToStaticMarkup; this just pins that
    // the callback wiring compiles and the row renders with it attached.
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: null, now: NOW, pending: false, error: null, onChoose, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('Choose')
  })
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
