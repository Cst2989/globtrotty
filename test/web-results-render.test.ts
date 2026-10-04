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
import { HotelList } from '../web/components/HotelList.js'
import {
  HotelCard, amenityChips, essentialsLine, locationLine, ratingNumber, ratingWord, transitLine,
  typeLabel,
} from '../web/components/HotelCard.js'
import { ChoiceCard } from '../web/components/ChoiceCard.js'
import {
  FilterBar, stopsModeOf, withStopsMode, bagsLabel, priceLabel, airlinesLabel, starsLabel,
  amenitiesLabel,
} from '../web/components/FilterBar.js'
import { SortTabs, tabSummary } from '../web/components/SortTabs.js'
import { ResultsSkeleton } from '../web/components/ResultsSkeleton.js'
import { PinnedSummary } from '../web/components/PinnedSummary.js'
import {
  ResultsPane, outcomeForStatus, shouldAutoRefresh, splitByVerdict, unmatchedLabel,
} from '../web/components/ResultsPane.js'
import { SummaryBar, summarySegments, nightsBetween } from '../web/components/SummaryBar.js'
import { MessageBubble } from '../web/components/MessageBubble.js'
import { applyFilterLite } from '../web/filters.js'
import type { ResultItemLite, ResultsView, ProposalRowLite, LinkLite } from '../web/data.js'
import { hotelLite } from './helpers/web-lite.js'

const NOW = new Date('2026-11-18T09:00:00.000Z')

const FLIGHT_ITEM: ResultItemLite = {
  sourceId: 'F1', name: 'Qatar Airways', priceMinor: '84500', currency: 'EUR',
  fetchedAt: '2026-11-18T08:50:00.000Z', ttlSeconds: 900, expired: false,
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
  fetchedAt: '2026-11-18T08:50:00.000Z', ttlSeconds: 900, expired: false,
  hotel: hotelLite({
    rating: 4.4, nights: 16, checkIn: '2026-11-20', checkOut: '2026-12-06',
    propertyType: 'hotel', stars: 3, reviews: 350,
    images: ['https://lh3.googleusercontent.com/a.png', 'https://lh3.googleusercontent.com/b.png'],
    amenities: ['Free Wi-Fi', 'Parking ($)', 'Air conditioning'],
    essentials: [],
    nearby: [
      { name: 'Asakusa-Kotobukicho', minutes: 2, by: 'Walking' },
      { name: 'Haneda Airport', minutes: 28, by: 'Taxi' },
    ],
    pricePerNightMinor: '7000', distanceKm: 3.2,
  }),
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
  it('renders one card per stay, with the party size the search was for', () => {
    const html = renderToStaticMarkup(
      createElement(HotelList, { items: [HOTEL_ITEM], adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('hotel-list')
    expect(html).toContain('Hotel Gracery')
    expect(html).toContain('16 nights, 2 adults')
    expect(html).toMatch(/Select/)
  })

  it('renders a chosen hotel pinned, with no Select button', () => {
    const html = renderToStaticMarkup(
      createElement(HotelList, { items: [HOTEL_ITEM], adults: 2, now: NOW, chosenSourceId: 'H1', onChoose: () => {} }),
    )
    expect(html).toContain('Chosen')
    expect(html).not.toContain('<button')
  })
})

describe('HotelCard', () => {
  it('renders the photo, the name, the stars, the type, where it is and how to reach the airport', () => {
    const html = renderToStaticMarkup(
      createElement(HotelCard, { item: HOTEL_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('Hotel Gracery')
    expect(html).toContain('src="https://lh3.googleusercontent.com/a.png"')
    expect(html).toContain('3-star')
    expect(html).toContain('Hotel')
    expect(html).toContain('Asakusa-Kotobukicho · 3.2 km from centre')
    expect(html).toContain('28 min to Haneda Airport by taxi')
    // One dot per photo, and only when there is more than one.
    expect(html.match(/hotel-photo-dot"/g)).toHaveLength(2)
  })

  it('renders the rating badge with its word, the review count, the stay and both prices', () => {
    const html = renderToStaticMarkup(
      createElement(HotelCard, { item: HOTEL_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('4.4')
    expect(html).toContain('Very good')
    expect(html).toContain('350 reviews')
    expect(html).toContain('16 nights, 2 adults')
    expect(html).toContain('€1,120.00')
    expect(html).toContain('€70.00 per night')
    expect(html).toMatch(/Select/)
  })

  it('renders the amenity chips this office has words for, in its own vocabulary', () => {
    const html = renderToStaticMarkup(
      createElement(HotelCard, { item: HOTEL_ITEM, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('>Wifi<')
    expect(html).toContain('>Parking<')
    expect(html).toContain('>Air conditioning<')
    // The supplier's own spelling never reaches the card when ours covers it.
    expect(html).not.toContain('Parking ($)')
  })

  it('renders a rental\'s own essentials line and type label instead', () => {
    const rental: ResultItemLite = {
      ...HOTEL_ITEM,
      hotel: hotelLite({
        propertyType: 'rental', rating: 4.1, reviews: 23, nights: 16,
        essentials: ['Entire apartment', '1 bedroom', '2 beds'],
      }),
    }
    const html = renderToStaticMarkup(
      createElement(HotelCard, { item: rental, adults: 2, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('Apartment')
    expect(html).toContain('Entire apartment · 1 bedroom · 2 beds')
  })

  it('invents nothing for a bare stay: no photo, no stars, no rating, no distance', () => {
    const bare: ResultItemLite = { ...HOTEL_ITEM, hotel: hotelLite({ propertyType: 'other' }) }
    const html = renderToStaticMarkup(
      createElement(HotelCard, { item: bare, adults: 1, now: NOW, onChoose: () => {} }),
    )
    expect(html).toContain('data-empty="true"')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('hotel-rating-score')
    expect(html).not.toContain('km from centre')
    expect(html).not.toContain('per night')
    expect(html).not.toContain('hotel-card-type')
    expect(html).toContain('7 nights, 1 adult')
  })

  it('renders a chosen stay pinned, with no Select button', () => {
    const html = renderToStaticMarkup(
      createElement(HotelCard, { item: HOTEL_ITEM, adults: 2, now: NOW, chosen: true, onChoose: () => {} }),
    )
    expect(html).toContain('Selected')
    expect(html).toContain('Chosen')
    expect(html).not.toContain('<button')
  })
})

describe('the hotel card\'s pure pieces', () => {
  it('bands a rating into Booking\'s own words, and withholds a word below 3.5', () => {
    expect(ratingWord(4.8)).toBe('Excellent')
    expect(ratingWord(4.5)).toBe('Excellent')
    expect(ratingWord(4.0)).toBe('Very good')
    expect(ratingWord(3.5)).toBe('Good')
    expect(ratingWord(3.4)).toBeNull()
    expect(ratingNumber(4)).toBe('4.0')
    expect(ratingNumber(4.1130433)).toBe('4.1')
  })

  it('labels the two types it trusts and nothing else', () => {
    expect(typeLabel('hotel')).toBe('Hotel')
    expect(typeLabel('rental')).toBe('Apartment')
    expect(typeLabel('other')).toBeNull()
  })

  it('reads the area off the first nearby place that is not an airport', () => {
    const nearby = [{ name: 'Haneda Airport' }, { name: 'Sugamo Sta.' }]
    expect(locationLine(nearby, 4.6)).toBe('Sugamo Sta. · 4.6 km from centre')
    expect(locationLine([{ name: 'Haneda Airport' }], 4.6)).toBe('4.6 km from centre')
    expect(locationLine(nearby, null)).toBe('Sugamo Sta.')
    expect(locationLine([], null)).toBeNull()
    // A name that masked to nothing readable is skipped rather than printed as a run of '?'.
    expect(locationLine([{ name: '?????' }, { name: 'Sugamo Sta.' }], null)).toBe('Sugamo Sta.')
    expect(locationLine([{ name: '?????' }], 12.4)).toBe('12.4 km from centre')
  })

  it('writes the transit line only for an airport carrying both a time and a way of getting there', () => {
    expect(transitLine([{ name: 'Haneda Airport', minutes: 39, by: 'Taxi' }]))
      .toBe('39 min to Haneda Airport by taxi')
    expect(transitLine([{ name: 'Haneda Airport', minutes: null, by: 'Taxi' }])).toBeNull()
    expect(transitLine([{ name: 'Sensoji', minutes: 9, by: 'Walking' }])).toBeNull()
  })

  it('joins the essentials and refuses to make one up', () => {
    expect(essentialsLine(['Entire house', 'Sleeps 4'])).toBe('Entire house · Sleeps 4')
    expect(essentialsLine([])).toBeNull()
  })

  it('prefers the chips a traveller scans for, then fills the row with what is left', () => {
    expect(amenityChips(['Smoke-free', 'Free Wi-Fi', 'Outdoor pool', 'Microwave', 'Sauna', 'Crib', 'Washer']))
      .toEqual(['Wifi', 'Pool', 'Spa', 'Smoke-free', 'Microwave'])
    expect(amenityChips([])).toEqual([])
    // Five at most, however many came back.
    expect(amenityChips(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(5)
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

  // Pass 3, section 6b: a click posts the label as an ordinary message, so clicking twice would
  // send it twice. `ChoiceCardLive` sets `disabled` in the same tick it fires the optimistic
  // bubble, before the POST.
  it('disables every option while a pick is in flight, as a card and as chips', () => {
    for (const variant of ['card', 'chips'] as const) {
      const html = renderToStaticMarkup(
        createElement(ChoiceCard, {
          question: 'What next?', variant, disabled: true,
          options: [{ id: 'direct_only', label: 'Direct flights only' }, { id: 'cheapest', label: 'Cheapest first' }],
          onPick: () => {},
        }),
      )
      expect([...html.matchAll(/disabled=""/g)]).toHaveLength(2)
    }
  })
})

// Pass 3, section 3: the left rail became one horizontal bar above the list. The controls she
// touches constantly stay on the surface; the three she touches occasionally sit behind triggers
// that say what is set inside them.
describe('FilterBar', () => {
  const items: ResultItemLite[] = [
    FLIGHT_ITEM,
    {
      ...FLIGHT_ITEM, sourceId: 'F2', priceMinor: '20000',
      flight: { ...FLIGHT_ITEM.flight!, airlines: ['LH'], airlineNames: ['Lufthansa'] },
    },
  ]

  function bar(props: Partial<Parameters<typeof FilterBar>[0]> = {}) {
    return renderToStaticMarkup(createElement(FilterBar, {
      kind: 'flights', items, filter: {}, onChange: () => {}, ...props,
    }))
  }

  it('is one row: a stops segmented control, a Bags trigger, the departure chips, a price trigger and an Airlines trigger', () => {
    const html = bar()
    expect(html).toContain('filter-bar')
    for (const label of ['Any', 'Direct', '1 stop', '2 stops']) expect(html).toContain(`>${label}<`)
    expect([...html.matchAll(/class="filter-segment"/g)]).toHaveLength(4)
    expect(html).toContain('Bags')
    expect(html).toContain('Morning')
    expect(html).toContain('Max price')
    expect(html).toContain('Airlines')
    // No radios and no rail: the four stops options are one segmented control.
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('filter-rail')
  })

  it('keeps every popover closed by default — no panel, and nothing inside one, in the markup', () => {
    const html = bar()
    expect(html).not.toContain('filter-pop-panel')
    expect(html).not.toContain('Cabin bags')
    expect(html).not.toContain('type="range"')
    expect(html).not.toContain('Qatar Airways')
    expect([...html.matchAll(/aria-expanded="false"/g)]).toHaveLength(3)
  })

  it('opens exactly the one popover it is asked to, with its own contents', () => {
    const bags = bar({ openPopover: 'bags' })
    expect([...bags.matchAll(/filter-pop-panel/g)]).toHaveLength(1)
    expect(bags).toContain('Cabin bags')
    expect(bags).toContain('Checked bags')

    const price = bar({ openPopover: 'price' })
    expect(price).toContain('type="range"')

    const airlines = bar({ openPopover: 'airlines' })
    // Each airline by NAME with how many results carry it, which the old chip row could never fit.
    expect(airlines).toContain('Qatar Airways')
    expect(airlines).toContain('Lufthansa')
    expect([...airlines.matchAll(/type="checkbox"/g)]).toHaveLength(2)
  })

  it('presses the matching segment for the stops option that is set', () => {
    expect(/aria-pressed="true"[^>]*>Any</.test(bar())).toBe(true)
    expect(/aria-pressed="true"[^>]*>Direct</.test(bar({ filter: { nonstop: true } }))).toBe(true)
    expect(/aria-pressed="true"[^>]*>1 stop</.test(bar({ filter: { maxStops: 1 } }))).toBe(true)
  })

  it('says on the closed trigger what is set inside it', () => {
    expect(bar({ filter: { minCabinBags: 1 } })).toContain('Bags: 1 cabin')
    expect(bar({ filter: { maxPriceMinor: '20000' } })).toContain('Up to €200.00')
    expect(bar({ filter: { airlines: ['QR', 'LH'] } })).toContain('Airlines (2)')
    // And marks it, so the row reads as filtered at a glance.
    expect(bar({ filter: { minCabinBags: 1 } })).toContain('data-set="true"')
    expect(bar()).not.toContain('data-set="true"')
  })

  it('offers Clear only once something is set', () => {
    expect(bar()).not.toContain('>Clear<')
    expect(bar({ filter: { minCheckedBags: 1 } })).toContain('>Clear<')
  })

  it('gives the hotels bar its own six controls, and none of the flight ones', () => {
    const html = renderToStaticMarkup(createElement(FilterBar, {
      kind: 'hotels', items: [HOTEL_ITEM], filter: {}, onChange: () => {},
    }))
    // Hotels pass, section 4: 4+ and 4.5+ rather than 3+ and 4+ — see `RATING_OPTIONS`.
    expect(html).toContain('4+')
    expect(html).toContain('4.5+')
    expect(html).not.toContain('>3+<')
    expect(html).toContain('Hotels')
    expect(html).toContain('Rentals')
    expect(html).toContain('Stars')
    expect(html).toContain('Amenities')
    expect(html).toContain('Near the centre')
    expect(html).toContain('Max price')
    expect(html).not.toContain('Bags')
    expect(html).not.toContain('Morning')
    expect(html).not.toContain('Airlines')
  })

  it('opens the stars and amenities panels with this office\'s own words, never a supplier label', () => {
    const stars = renderToStaticMarkup(createElement(FilterBar, {
      kind: 'hotels', items: [HOTEL_ITEM], filter: { stars: [4, 5] }, onChange: () => {},
      openPopover: 'stars' as const,
    }))
    expect(stars).toContain('Stars: 4, 5')
    expect(stars).toContain('3 star')
    const amenities = renderToStaticMarkup(createElement(FilterBar, {
      kind: 'hotels', items: [HOTEL_ITEM], filter: { amenities: ['wifi'] }, onChange: () => {},
      openPopover: 'amenities' as const,
    }))
    expect(amenities).toContain('Amenities (1)')
    expect(amenities).toContain('Air conditioning')
    // The internal key never reaches her.
    expect(amenities).not.toContain('air_conditioning')
  })

  it('labels what is set inside a closed stars or amenities trigger', () => {
    expect(starsLabel({})).toBe('Stars')
    expect(starsLabel({ stars: [5, 3] })).toBe('Stars: 3, 5')
    expect(amenitiesLabel({})).toBe('Amenities')
    expect(amenitiesLabel({ amenities: ['wifi', 'pool'] })).toBe('Amenities (2)')
  })

  it('presses the matching rating segment', () => {
    const html = renderToStaticMarkup(createElement(FilterBar, {
      kind: 'hotels', items: [HOTEL_ITEM], filter: { minRating: 4 }, onChange: () => {},
    }))
    expect(/aria-pressed="true"[^>]*>4\+</.test(html)).toBe(true)
  })
})

describe('the filter bar\'s trigger labels', () => {
  it('names the bags that are set, and nothing when none are', () => {
    expect(bagsLabel({})).toBe('Bags')
    expect(bagsLabel({ minCabinBags: 1 })).toBe('Bags: 1 cabin')
    expect(bagsLabel({ minCheckedBags: 2 })).toBe('Bags: 2 checked')
    expect(bagsLabel({ minCabinBags: 1, minCheckedBags: 1 })).toBe('Bags: 1 cabin, 1 checked')
  })

  it('names the cap that is set', () => {
    expect(priceLabel({}, 'EUR')).toBe('Max price')
    expect(priceLabel({ maxPriceMinor: '250000' }, 'EUR')).toBe('Up to €2,500.00')
  })

  it('counts the airlines that are set', () => {
    expect(airlinesLabel({})).toBe('Airlines')
    expect(airlinesLabel({ airlines: [] })).toBe('Airlines')
    expect(airlinesLabel({ airlines: ['QR'] })).toBe('Airlines (1)')
    expect(airlinesLabel({ airlines: ['QR', 'LH'] })).toBe('Airlines (2)')
  })
})

describe('stopsModeOf / withStopsMode', () => {
  it('reads the one stops answer out of a filter', () => {
    expect(stopsModeOf({})).toBe('any')
    expect(stopsModeOf({ nonstop: true })).toBe('direct')
    // A typed message can set `maxStops: 0`, which says the same thing as `nonstop`.
    expect(stopsModeOf({ maxStops: 0 })).toBe('direct')
    expect(stopsModeOf({ maxStops: 1 })).toBe('max1')
    expect(stopsModeOf({ maxStops: 2 })).toBe('max2')
  })

  it('writes `nonstop` for Direct, the field a typed "only direct flights" also sets', () => {
    expect(withStopsMode({}, 'direct')).toEqual({ nonstop: true })
    expect(withStopsMode({}, 'max1')).toEqual({ maxStops: 1 })
    expect(withStopsMode({ nonstop: true }, 'any')).toEqual({})
  })

  it('leaves every other field of the filter alone', () => {
    expect(withStopsMode({ nonstop: true, airlines: ['QR'], minCheckedBags: 1 }, 'max2'))
      .toEqual({ maxStops: 2, airlines: ['QR'], minCheckedBags: 1 })
  })
})

describe('SortTabs', () => {
  const cheap = {
    ...FLIGHT_ITEM, sourceId: 'F2', priceMinor: '20000',
    flight: { ...FLIGHT_ITEM.flight!, durationMinutes: 1200 },
  }

  it('renders one tab per sort, each summarising the item it would lead with', () => {
    const html = renderToStaticMarkup(createElement(SortTabs, {
      items: [FLIGHT_ITEM, cheap], sorts: ['best', 'cheapest', 'fastest'],
      active: 'best', onChange: () => {},
    }))
    expect(html).toContain('Best')
    expect(html).toContain('Cheapest')
    expect(html).toContain('Fastest')
    // Best leads with the stored first item (€845.00, 14h 15m); Cheapest with the €200 one.
    expect(html).toContain('€845.00 · 14h 15m')
    expect(html).toContain('€200.00 · 20h 0m')
  })

  it('marks only the active tab', () => {
    const html = renderToStaticMarkup(createElement(SortTabs, {
      items: [FLIGHT_ITEM], sorts: ['best', 'cheapest'], active: 'cheapest', onChange: () => {},
    }))
    expect([...html.matchAll(/aria-pressed="true"/g)]).toHaveLength(1)
    expect(/aria-pressed="true"[\s\S]*?Cheapest/.test(html)).toBe(true)
  })

  it('summarises a stay with its price and its rating — a hotel row has no duration', () => {
    expect(tabSummary(HOTEL_ITEM)).toBe('€1,120.00 · 4.4')
    expect(tabSummary({ ...HOTEL_ITEM, hotel: hotelLite({ rating: null }) })).toBe('€1,120.00')
    expect(tabSummary(null)).toBe('—')
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

  // Pass 3, section 6d: the hand-off re-checks every price with the supplier before it mints a
  // link, which takes seconds; an unchanged button through all of them reads as one that did
  // nothing.
  it('says Checking prices… while the hand-off is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(PinnedSummary, {
        items, totalMinor: '84500', currency: 'EUR', decision: null, links: [],
        pending: true, error: null, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('Checking prices…')
    expect(html).not.toContain('Get booking links')
    expect(html).toContain('disabled=""')
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
    fetchedAt: FLIGHT_ITEM.fetchedAt, stale: false,
    cityNames: { BCN: 'Barcelona', HND: 'Tokyo' },
    verdicts: undefined,
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
  it('starts the filter bar from the results row\'s own filter, and narrows the list to match', () => {
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
    // The bar's Direct segment is pressed...
    expect(/aria-pressed="true"[^>]*>Direct</.test(html)).toBe(true)
    // ...and FLIGHT_ITEM (one stop, via Doha) is filtered out of the list below it, leaving only
    // the direct card. Source ids are not rendered, so the cards are counted and the excluded
    // item is identified by its own stops line.
    expect(html.match(/class="flight-card"/g)).toHaveLength(1)
    expect(html).toContain('data-direct="true"')
    expect(html).not.toContain('1 stop, Doha')
  })

  it('leaves the bar on its defaults when the row carries no filter', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: null, now: NOW, pending: false, error: null,
        onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(/aria-pressed="true"[^>]*>Any</.test(html)).toBe(true)
    expect(html).not.toContain('>Clear<')
  })

  // D: the sort tabs read the FILTERED list, so a tab's summary never advertises a price the
  // list below it does not contain.
  it('puts the sort tabs above the list, starting on Best', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView()], proposal: null, now: NOW, pending: false, error: null,
        onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(html.indexOf('sort-tabs')).toBeLessThan(html.indexOf('flight-card'))
    expect(/aria-pressed="true"[\s\S]*?Best/.test(html)).toBe(true)
    expect(html).toContain('Fastest')
  })

  it('gives the hotels section its own filter bar, with none of the flight controls in it', () => {
    const html = renderToStaticMarkup(
      createElement(ResultsPane, {
        results: [resultsView({ messageId: 'm2', kind: 'hotels', items: [HOTEL_ITEM] })],
        proposal: null, now: NOW, pending: false, error: null, onChoose: () => {}, onGetLinks: () => {},
      }),
    )
    expect(html).toContain('4.5+')
    expect(html).toContain('Near the centre')
    expect(html).toContain('Max price')
    expect(html).not.toContain('Bags')
    // A stay has no duration to be fast; "Top rated" is the hotels pass's third tab.
    expect(html).not.toContain('Fastest')
    expect(html).toContain('Top rated')
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
        adults: 2, now: NOW, onChoose: () => {},
      }),
    )
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('ResultsSkeleton', () => {
  it('renders the bar, the tabs, five cards and a line built from nothing she typed', () => {
    const html = renderToStaticMarkup(createElement(ResultsSkeleton, { kind: 'flights' }))
    expect(html).toContain('Searching flights…')
    expect([...html.matchAll(/skeleton-card/g)]).toHaveLength(5)
    expect(html).toContain('summary-bar')
    expect(html).toContain('sort-tabs')
    // Pass 3, section 3: the filter placeholder is a horizontal row now, like the real thing.
    expect(html).toContain('filter-bar')
  })

  it('says hotels for the hotel pass', () => {
    const html = renderToStaticMarkup(createElement(ResultsSkeleton, { kind: 'hotels' }))
    expect(html).toContain('Searching hotels…')
  })
})

// Pass 3, section 1 + the author's correction to it. The bug: a page refresh fifteen minutes
// after a search rendered an EMPTY list, because `loadResults` dropped every expired item. The
// items now stay; their PRICES become shimmer while the pane re-runs the search by itself. No
// banner, no button: she never wanted stale prices, she wanted current ones.
describe('shouldAutoRefresh', () => {
  it('re-runs a stale row without being asked', () => {
    expect(shouldAutoRefresh({ stale: true }, 'active')).toBe(true)
    expect(shouldAutoRefresh({ stale: true }, 'awaiting_user')).toBe(true)
  })

  it('leaves a fresh row alone', () => {
    expect(shouldAutoRefresh({ stale: false }, 'active')).toBe(false)
  })

  it('never fires while a turn is already in flight — it would be refused with a 409', () => {
    expect(shouldAutoRefresh({ stale: true }, 'working')).toBe(false)
  })
})

describe('expired prices', () => {
  const EXPIRED_ITEM: ResultItemLite = { ...FLIGHT_ITEM, expired: true }
  const LATER = new Date('2026-11-18T10:55:00.000Z')   // two hours after FLIGHT_ITEM's fetchedAt

  it('replaces the price with a shimmer while the refresh runs, and keeps the itinerary', () => {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      item: EXPIRED_ITEM, adults: 2, now: LATER, updating: true, onChoose: () => {},
    }))
    expect(html).toContain('skeleton-line-price')
    expect(html).not.toContain('€845.00')
    expect(html).toContain('Updating prices')
    // Everything a ttl does not expire is still there.
    expect(html).toContain('07:05')
    expect(html).toContain('1 stop, Doha')
    expect(html).toContain('alt="Qatar Airways"')
    expect(html).toContain('personal items included')
    // And nothing can be acted on until the number comes back.
    expect(html).toContain('disabled=""')
  })

  it('pairs each card with itself across the re-render, so the new order animates', () => {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      item: FLIGHT_ITEM, adults: 2, now: NOW, onChoose: () => {},
    }))
    expect(html).toContain('view-transition-name:card-F1')
  })

  it('puts the old prices back with their age when the refresh has failed', () => {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      item: EXPIRED_ITEM, adults: 2, now: LATER, onChoose: () => {},
    }))
    expect(html).toContain('€845.00')
    expect(html).not.toContain('skeleton-line-price')
    expect(html).toContain('Prices from 2 h ago')
    expect(html).toContain('data-expired="true"')
    expect(html).toContain('title="These prices are out of date"')
  })

  it('leaves a fresh card alone', () => {
    const html = renderToStaticMarkup(createElement(FlightCard, {
      item: FLIGHT_ITEM, adults: 2, now: NOW, onChoose: () => {},
    }))
    expect(html).not.toContain('data-expired')
    expect(html).not.toContain('disabled')
    expect(html).toContain('found 10 min ago')
    expect(html).not.toContain('skeleton-line-price')
  })

  it('gives an expired hotel row the same treatment', () => {
    const html = renderToStaticMarkup(createElement(HotelList, {
      items: [{ ...HOTEL_ITEM, expired: true }], adults: 2, now: LATER, updating: true, onChoose: () => {},
    }))
    expect(html).toContain('skeleton-line-price')
    expect(html).toContain('Updating prices')
    expect(html).toContain('Hotel Gracery')
  })

  it('renders a stale row as price skeletons, with no banner and no button anywhere', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView({ items: [EXPIRED_ITEM], stale: true })],
      proposal: null, now: LATER, pending: false, error: null, updatingKinds: ['flights'],
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('skeleton-line-price')
    expect(html).toContain('Updating prices')
    expect(html).not.toContain('stale-banner')
    expect(html).not.toContain('Refresh prices')
    // The list itself is there from the first frame — that is the whole fix.
    expect(html).toContain('flight-card')
    expect(html).toContain('1 stop, Doha')
  })

  it('shimmers the sort tabs\' own summaries too, so no row advertises a hidden price', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView({ items: [EXPIRED_ITEM], stale: true })],
      proposal: null, now: LATER, pending: false, error: null, updatingKinds: ['flights'],
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('sort-tab-skeleton')
    expect(html).not.toContain('sort-tab-summary')
  })

  it('shows real prices again once the refreshed row has landed', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView()], proposal: null, now: NOW, pending: false, error: null,
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('€845.00')
    expect(html).not.toContain('skeleton-line-price')
    expect(html).not.toContain('Updating prices')
  })
})

// Pass 3, section 6. Pressing Select used to change nothing for about three seconds. Everything
// the eventual answer shows is already known the moment she clicks, so it all renders at once.
describe('outcomeForStatus', () => {
  it('keeps the optimistic screen only on a 200', () => {
    expect(outcomeForStatus(200)).toBe('keep')
  })

  it('rolls back on 409, 429, 404, 500 and a network error — `submitAction` wrote nothing', () => {
    for (const status of [400, 404, 409, 429, 500, 0]) {
      expect(outcomeForStatus(status)).toBe('rollback')
    }
  })
})

describe('ResultsPane with a pendingChoice', () => {
  const SECOND_FLIGHT: ResultItemLite = {
    ...FLIGHT_ITEM, sourceId: 'F2', name: 'Finnair',
    flight: { ...FLIGHT_ITEM.flight!, stops: 0, airlines: ['AY'], airlineNames: ['Finnair'] },
  }

  function paneWith(pendingChoice: { kind: 'flight' | 'hotel'; sourceId: string } | null, results = [
    resultsView({ items: [FLIGHT_ITEM, SECOND_FLIGHT] }),
  ]) {
    return renderToStaticMarkup(createElement(ResultsPane, {
      results, proposal: null, now: NOW, pending: false, error: null, pendingChoice,
      onChoose: () => {}, onGetLinks: () => {},
    }))
  }

  it('ribbons the chosen card, disables every other Select, and pins the choice at the top', () => {
    const html = paneWith({ kind: 'flight', sourceId: 'F1' })
    // The one she picked: the ribbon, and no button at all on that card.
    expect(html).toContain('Selected')
    expect([...html.matchAll(/flight-card-ribbon/g)]).toHaveLength(1)
    // One Select left (the other card's), and it is dead.
    expect([...html.matchAll(/>Select</g)]).toHaveLength(1)
    expect(html).toContain('disabled=""')
    // The pinned block, with her card's own name and price — above the lists.
    expect(html).toContain('Chosen flight')
    expect(html).toContain('€845.00')
    expect(html.indexOf('Chosen flight')).toBeLessThan(html.indexOf('flight-card'))
  })

  it('promises the hotel search a chosen flight starts', () => {
    const html = paneWith({ kind: 'flight', sourceId: 'F1' })
    expect(html).toContain('Searching hotels…')
    expect(html.indexOf('Searching hotels…')).toBeLessThan(html.indexOf('flight-card'))
  })

  it('promises the trip summary a chosen HOTEL starts, not another list', () => {
    const html = paneWith(
      { kind: 'hotel', sourceId: 'H1' },
      [resultsView({ messageId: 'm2', kind: 'hotels', items: [HOTEL_ITEM] })],
    )
    expect(html).toContain('Putting the trip together…')
    expect(html).not.toContain('Searching hotels…')
    expect(html).toContain('Chosen hotel')
    // Her row keeps its "Chosen" marker and loses its button, like the real thing.
    expect(html).toContain('result-row-chosen')
    expect(html).not.toContain('>Choose<')
  })

  it('leaves every Select alive and promises nothing with no pendingChoice', () => {
    const html = paneWith(null)
    expect([...html.matchAll(/>Select</g)]).toHaveLength(2)
    // Both Select buttons, neither disabled. (The filter bar's own steppers carry a `disabled`
    // of their own at zero, so this looks at the buttons in question rather than the whole page.)
    expect([...html.matchAll(/<button type="button" class="btn btn-primary">Select<\/button>/g)]).toHaveLength(2)
    expect(html).not.toContain('Chosen flight')
    expect(html).not.toContain('Searching hotels…')
  })

})

describe('ResultsPane skeletons', () => {
  it('replaces the whole pane while the first search runs', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [], proposal: null, now: NOW, pending: false, error: null, skeleton: 'full',
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('Searching flights…')
    expect(html).not.toContain('Select')
  })

  it('puts a hotel skeleton ABOVE the flights she already has, leaving them in place', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView()], proposal: null, now: NOW, pending: false, error: null, skeleton: 'hotels',
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html.indexOf('Searching hotels…')).toBeGreaterThan(-1)
    expect(html.indexOf('Searching hotels…')).toBeLessThan(html.indexOf('flight-card'))
    expect(html).toContain('Barcelona BCN → Tokyo HND')
  })

  it('shows no skeleton at all once the results are in', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView()], proposal: null, now: NOW, pending: false, error: null, skeleton: null,
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).not.toContain('Searching')
  })
})

/**
 * Section 7 in the pane: matched items keep their place with green chips, what Jev found wrong
 * drops into a collapsed section, the tabs count only the matched list, and a row nothing checked
 * says so instead of implying everything passed.
 */
describe('verified results', () => {
  const SECOND_FLIGHT: ResultItemLite = { ...FLIGHT_ITEM, sourceId: 'F2', priceMinor: '60000' }
  const verdicts = {
    F1: { matches: ['Premium economy', '1 stop'], issues: [] },
    F2: { matches: [], issues: ['Not the cabin you asked for', 'Self-transfer risk'] },
  }

  it('splits on the issues, and treats an unchecked item as matched rather than hiding it', () => {
    const items = [FLIGHT_ITEM, SECOND_FLIGHT, { ...FLIGHT_ITEM, sourceId: 'F3' }]
    const split = splitByVerdict(items, verdicts)
    expect(split.matched.map((i) => i.sourceId)).toEqual(['F1', 'F3'])
    expect(split.unmatched.map((i) => i.sourceId)).toEqual(['F2'])
    // No verdicts at all: nothing was checked, so nothing is hidden.
    expect(splitByVerdict(items, undefined).unmatched).toEqual([])
    expect(splitByVerdict(items, undefined).matched).toHaveLength(3)
  })

  it('counts and names what did not match', () => {
    expect(unmatchedLabel(3, 'flights')).toBe('3 flights didn\'t match what you asked')
    expect(unmatchedLabel(1, 'flights')).toBe('1 flight didn\'t match what you asked')
    expect(unmatchedLabel(1, 'hotels')).toBe('1 hotel didn\'t match what you asked')
  })

  it('renders green check chips on a matched card', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView({ items: [FLIGHT_ITEM, SECOND_FLIGHT], verdicts })],
      proposal: null, now: NOW, pending: false, error: null,
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('match-chip')
    expect(html).toContain('Premium economy')
    expect(html).toContain('1 stop')
  })

  it('puts what did not match in a collapsed section, with its reasons, and keeps it off the tabs', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView({ items: [FLIGHT_ITEM, SECOND_FLIGHT], verdicts })],
      proposal: null, now: NOW, pending: false, error: null,
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('1 flight didn&#x27;t match what you asked')
    // Collapsed on first render: the reasons and the second card are behind the toggle.
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Self-transfer risk')
    // The tabs summarise the matched list only — €845.00 is F1's price, not F2's cheaper one.
    expect(html).toContain('€845.00')
    expect(html).not.toContain('€600.00')
    expect(html).not.toContain('Not checked against your request')
  })

  it('says so, once, when nothing checked the list', () => {
    const html = renderToStaticMarkup(createElement(ResultsPane, {
      results: [resultsView({ items: [FLIGHT_ITEM, SECOND_FLIGHT], verdicts: undefined })],
      proposal: null, now: NOW, pending: false, error: null,
      onChoose: () => {}, onGetLinks: () => {},
    }))
    expect(html).toContain('Not checked against your request')
    expect(html).not.toContain('didn&#x27;t match what you asked')
    expect(html).not.toContain('match-chip')
    // Both cards are in the one list.
    expect(html).toContain('€845.00')
    expect(html).toContain('€600.00')
  })

  it('renders the chips on a stay too', () => {
    const html = renderToStaticMarkup(createElement(HotelCard, {
      item: HOTEL_ITEM, adults: 2, now: NOW,
      matches: ['Hotel', 'Near the centre', 'Well rated'],
      onChoose: () => {},
    }))
    expect(html).toContain('match-chip')
    expect(html).toContain('Near the centre')
    expect(html).toContain('Well rated')
  })
})
