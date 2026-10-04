/**
 * Trip-stage pass, section 3: what the chat says about a trip.
 *
 * `.ts`, not `.tsx`: esbuild's `.ts` loader does not parse JSX, so every element is built with
 * `createElement`.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  BookingLinks, EarlierProposals, TripCard, datesLine, isTrip, itemLine, proposalMarker,
  splitProposals, type TripProposal,
} from '../web/components/TripCard.js'
import { errorForStatus } from '../web/components/errors.js'

const NOW_ISO = '2026-10-04T12:00:00.000Z'

const FLIGHT = {
  slot: 'flight', sourceId: 'F1', kind: 'flight' as const, name: 'China Eastern',
  priceMinor: '506400', currency: 'EUR', fetchedAt: NOW_ISO,
  route: { from: 'BCN', to: 'NRT', fromCity: 'Barcelona', toCity: 'Tokyo' },
  outbound: '2026-11-19', inbound: '2026-12-06', airline: 'China Eastern',
  stars: null, nights: null, ttlSeconds: 900,
}

const STAY = {
  slot: 'stay', sourceId: 'H1', kind: 'hotel' as const, name: 'Agora Tokyo Ginza',
  priceMinor: '324800', currency: 'EUR', fetchedAt: NOW_ISO, route: null,
  outbound: '2026-11-20', inbound: '2026-12-06', airline: null, stars: 4, nights: 16,
  ttlSeconds: 86_400,
}

function trip(overrides: Partial<TripProposal> = {}): TripProposal {
  return {
    id: 'p2', totalMinor: '831200', currency: 'EUR', gateOutcome: 'approved', reviewIssues: [],
    decision: null, items: [FLIGHT, STAY], links: [],
    ...overrides,
  }
}

function flightsOnly(overrides: Partial<TripProposal> = {}): TripProposal {
  return {
    id: 'p1', totalMinor: '506400', currency: 'EUR', gateOutcome: 'approved', reviewIssues: [],
    decision: 'accept', items: [FLIGHT], links: [],
    ...overrides,
  }
}

const NOOP = {
  pending: false, error: null,
  onAccept: () => {}, onReject: () => {}, onShift: () => {}, onChange: () => {},
}

/*
 * The screenshots at 16.23: two `Proposed trip` cards stacked in the thread, the lower one the
 * flights-only proposal the office writes and accepts for itself, with a `Total €5,064` that was
 * not the total of anything.
 */
describe('which proposal the chat draws', () => {
  it('draws the newest TRIP, and never a flights-only proposal', () => {
    expect(isTrip(trip())).toBe(true)
    expect(isTrip(flightsOnly())).toBe(false)

    const split = splitProposals([trip(), flightsOnly()])
    expect(split.current?.id).toBe('p2')
    expect(split.earlier.map((p) => p.id)).toEqual(['p1'])
  })

  it('draws no card at all while only the flight is recorded', () => {
    const split = splitProposals([flightsOnly()])
    expect(split.current).toBeNull()
    expect(split.earlier.map((p) => p.id)).toEqual(['p1'])
  })

  it('collapses every earlier proposal to one marker line', () => {
    expect(proposalMarker(trip())).toBe('Trip proposed · €8,312')
    const html = renderToStaticMarkup(
      createElement(EarlierProposals, { proposals: [trip({ id: 'p0' }), flightsOnly()] }),
    )
    expect(html).toContain('Earlier proposals (2)')
    // Collapsed on first render: the markers are behind the toggle.
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Trip proposed')
  })

  it('renders nothing when there is nothing earlier', () => {
    expect(renderToStaticMarkup(createElement(EarlierProposals, { proposals: [] }))).toBe('')
  })
})

describe('the lines a trip card reads', () => {
  it('names a flight by its carrier and a stay by itself, with the dates and the money', () => {
    expect(itemLine(FLIGHT).join(' · ')).toBe('Flight · China Eastern · 19 Nov to 6 Dec · €5,064')
    expect(itemLine(STAY).join(' · ')).toBe('Stay · Agora Tokyo Ginza · 16 nights · 20 Nov to 6 Dec · €3,248')
  })

  it('drops a part it cannot resolve rather than leaving a gap', () => {
    expect(itemLine({ ...FLIGHT, airline: null, outbound: null, inbound: null }).join(' · '))
      .toBe('Flight · China Eastern · €5,064')
    expect(datesLine({ ...FLIGHT, inbound: null })).toBe('19 Nov')
    expect(datesLine({ ...FLIGHT, outbound: null })).toBeNull()
  })

  it('drops the .00 on a whole number, and keeps a real fraction', () => {
    expect(itemLine({ ...STAY, priceMinor: '1250' })).toContain('€12.50')
  })
})

describe('TripCard', () => {
  it('is one card headed `Your trip`, with a line per item, a total and a status chip', () => {
    const html = renderToStaticMarkup(createElement(TripCard, { proposal: trip(), ...NOOP }))
    expect(html).toContain('Your trip')
    expect(html).toContain('Flight · China Eastern · 19 Nov to 6 Dec · €5,064')
    expect(html).toContain('Stay · Agora Tokyo Ginza · 16 nights · 20 Nov to 6 Dec · €3,248')
    expect(html).toContain('€8,312')
    expect(html).toContain('Waiting for your decision')
    // Never a second copy of the pane: no cards, no photo, no map.
    expect(html).not.toContain('hotel-card')
    expect(html).not.toContain('flight-card')
  })

  it('offers Accept, Reject and the four chips while undecided, and no Swap picker', () => {
    const html = renderToStaticMarkup(createElement(TripCard, { proposal: trip(), ...NOOP }))
    expect(html).toContain('>Accept<')
    expect(html).toContain('>Reject<')
    expect(html).toContain('Change the flight')
    expect(html).toContain('Change the hotel')
    expect(html).toContain('2 days earlier')
    expect(html).toContain('2 days later')
    expect(html).not.toContain('Swap')
    expect(html).not.toContain('<select')
  })

  it('loses its buttons once decided', () => {
    const html = renderToStaticMarkup(
      createElement(TripCard, { proposal: trip({ decision: 'reject' }), ...NOOP }),
    )
    expect(html).not.toContain('<button')
    expect(html).toContain('Rejected')
  })

  it('shows the reviewer\'s issues on a card the gates shipped unapproved', () => {
    const html = renderToStaticMarkup(createElement(TripCard, {
      proposal: trip({ gateOutcome: 'shipped_unapproved', reviewIssues: ['the stay is far out'] }),
      ...NOOP,
    }))
    expect(html).toContain('the stay is far out')
  })

  it('disables every button while a request from the card is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(TripCard, { proposal: trip(), ...NOOP, pending: true }),
    )
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])
    expect(buttons.length).toBeGreaterThan(0)
    for (const tag of buttons) expect(tag).toContain('disabled')
  })

  it('renders whatever error copy it is given, as plain text', () => {
    const html = renderToStaticMarkup(
      createElement(TripCard, { proposal: trip(), ...NOOP, error: errorForStatus(429) }),
    )
    expect(html).toContain('Today&#x27;s spending limit is reached')
  })
})

/* Section 3's end of the conversation: `Your links are ready`, and the two chips that open them. */
describe('the booking links', () => {
  const accepted = trip({
    decision: 'accept',
    links: [
      { itemId: 'F1', url: 'https://kiwi.example/F1?gt_ref=abc', quotedMinor: '506400', currency: 'EUR' },
      { itemId: 'H1', url: 'https://stay.example/H1?gt_ref=def', quotedMinor: '324800', currency: 'EUR' },
    ],
  })

  it('names each link for what it books, and opens it safely', () => {
    const html = renderToStaticMarkup(createElement(BookingLinks, { proposal: accepted }))
    expect(html).toContain('Your links are ready')
    expect(html).toContain('Book the flight')
    expect(html).toContain('Book the hotel')
    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(accepted.links.map((l) => l.url))
    expect([...html.matchAll(/rel="noopener noreferrer"/g)]).toHaveLength(2)
    expect([...html.matchAll(/target="_blank"/g)]).toHaveLength(2)
  })

  it('is the only place an accepted card has anchors at all', () => {
    const html = renderToStaticMarkup(createElement(TripCard, { proposal: accepted, ...NOOP }))
    expect([...html.matchAll(/<a /g)]).toHaveLength(2)
    expect(html).not.toContain('<button')
  })
})

describe('errorForStatus', () => {
  /*
   * A 429 from decide/revise is the spend ceiling — `submitAction` returns `limit_reached`
   * before its transaction, so nothing was written — and "please try again" would be advice that
   * cannot work today however many times she takes it.
   */
  it('maps 409 to busy, 429 to the spend ceiling, and everything else to the generic copy', () => {
    expect(errorForStatus(409)).toContain('already working on this trip')
    expect(errorForStatus(429)).toContain("Today's spending limit is reached")
    expect(errorForStatus(429)).not.toMatch(/try again/i)
    expect(errorForStatus(429)).not.toMatch(/saved/i)
    expect(errorForStatus(500)).toBe('That could not be sent. Please try again.')
    expect(errorForStatus(404)).toBe('That could not be sent. Please try again.')
  })
})
