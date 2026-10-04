/**
 * Trip-stage pass, section 2: exactly one layout per state, pinned here.
 *
 * `paneLayout` is pure, so every one of these is an assertion about a value rather than about
 * markup — which is the point of extracting it. The render side (that the pane actually draws
 * what this says) is in `test/web-results-render.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { paneLayout, UPDATED_REASON, type PaneLayoutInput } from '../web/components/paneLayout.js'
import type { ProposalRowLite, LinkLite, ResultsView } from '../web/data.js'
import type { PendingAction } from '../web/components/pending.js'
import { failWords } from '../web/components/StatusLine.js'

const NOW_ISO = '2026-10-04T12:00:00.000Z'

function row(kind: 'flights' | 'hotels', messageId: string, sourceIds: string[]): ResultsView {
  return {
    messageId, kind,
    query: { from: 'BCN', to: 'HND', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2 },
    assumptions: [], filter: undefined,
    items: sourceIds.map((sourceId) => ({
      sourceId, name: sourceId, priceMinor: '100', currency: 'EUR', fetchedAt: NOW_ISO,
      ttlSeconds: 900, expired: false,
    })),
    fetchedAt: NOW_ISO, stale: false, cityNames: {}, verdicts: undefined, centre: null,
  }
}

type Proposal = ProposalRowLite & { links: LinkLite[] }

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', totalMinor: '100', currency: 'EUR', gateOutcome: 'approved', reviewIssues: [],
    decision: null, links: [],
    items: [{
      slot: 'flight', sourceId: 'F1', kind: 'flight', name: 'China Eastern', priceMinor: '100',
      currency: 'EUR', fetchedAt: NOW_ISO, route: null, outbound: '2026-11-19',
      inbound: '2026-12-06', airline: 'China Eastern', stars: null, nights: null, ttlSeconds: 900,
    }],
    ...overrides,
  }
}

const STAY = {
  slot: 'stay', sourceId: 'H1', kind: 'hotel' as const, name: 'Agora Tokyo Ginza',
  priceMinor: '200', currency: 'EUR', fetchedAt: NOW_ISO, route: null, outbound: '2026-11-20',
  inbound: '2026-12-06', airline: null, stars: 4, nights: 16, ttlSeconds: 86_400,
}

function layout(overrides: Partial<PaneLayoutInput> = {}) {
  return paneLayout({
    results: [], proposal: null, acceptedProposal: null, pending: null, ...overrides,
  })
}

const chooseFlight: PendingAction = { kind: 'choose_flight', label: '', at: 0, sourceId: 'F1' }
const chooseHotel: PendingAction = { kind: 'choose_hotel', label: '', at: 0, sourceId: 'H1' }

describe('the flights stage', () => {
  it('is the flights list and nothing else', () => {
    const l = layout({ results: [row('flights', 'm1', ['F1', 'F2'])] })
    expect(l.stage).toBe('flights')
    expect(l.flightsOpen).toBe(true)
    expect(l.hotelsOpen).toBe(false)
    expect(l.pinFlight).toBe(false)
    expect(l.pinHotel).toBe(false)
    expect(l.totals).toBe(false)
    expect(l.action).toBe('none')
    expect(l.skeleton).toBeNull()
  })

  it('is the whole-pane placeholder while the first search runs', () => {
    const l = layout({ skeleton: 'full' })
    expect(l.skeleton).toBe('flights')
    expect(l.flightsOpen).toBe(false)
    expect(l.hotelsOpen).toBe(false)
  })
})

describe('the hotels stage', () => {
  const results = [row('flights', 'm1', ['F1', 'F2']), row('hotels', 'm2', ['H1', 'H2'])]

  it('pins the chosen flight and makes the stays the list', () => {
    const l = layout({ results, proposal: proposal({ decision: 'accept' }) })
    expect(l.stage).toBe('hotels')
    expect(l.chosenFlight).toBe('F1')
    expect(l.pinFlight).toBe(true)
    expect(l.hotelsOpen).toBe(true)
    // The flights list is collapsed: she has finished with it.
    expect(l.flightsOpen).toBe(false)
    expect(l.hotelsCollapsible).toBe(false)
    expect(l.action).toBe('none')
  })

  it('reopens the flights list, with its own filters, when she presses Change', () => {
    const l = layout({ results, proposal: proposal({ decision: 'accept' }), flightsExpanded: true })
    expect(l.flightsOpen).toBe(true)
    expect(l.pinFlight).toBe(true)
  })

  it('starts the moment she presses Select, before the server has said anything', () => {
    const l = layout({ results: [row('flights', 'm1', ['F1'])], pending: chooseFlight })
    expect(l.stage).toBe('hotels')
    expect(l.chosenFlight).toBe('F1')
    expect(l.pinFlight).toBe(true)
    expect(l.skeleton).toBe('hotels')
  })

  /* Section 2's last rule: never a skeleton and a list of the same kind on screen together. */
  it('drops the hotels placeholder the instant a hotels row exists', () => {
    const l = layout({ results, pending: chooseFlight })
    expect(l.skeleton).toBeNull()
    expect(l.hotelsOpen).toBe(true)
  })

  it('leaves the list open when the chosen id is not in the newest row any more', () => {
    const refreshed = [row('flights', 'm3', ['F7', 'F8'])]
    const l = layout({ results: refreshed, proposal: proposal({ decision: 'accept' }) })
    expect(l.pinFlight).toBe(false)
  })
})

describe('the trip stage', () => {
  const results = [row('flights', 'm1', ['F1']), row('hotels', 'm2', ['H1', 'H2'])]
  const trip = proposal({ id: 'p2', items: [proposal().items[0]!, STAY], totalMinor: '300' })

  it('pins both cards, totals them, and offers one button', () => {
    const l = layout({ results, proposal: trip })
    expect(l.stage).toBe('trip')
    expect(l.pinFlight).toBe(true)
    expect(l.pinHotel).toBe(true)
    expect(l.totals).toBe(true)
    expect(l.action).toBe('accept')
    expect(l.changeable).toBe(true)
  })

  /* The 16.24 screenshot: the hotels list was still open under the stay she had chosen. */
  it('collapses the hotels list under `Other hotels`', () => {
    const l = layout({ results, proposal: trip })
    expect(l.hotelsOpen).toBe(false)
    expect(l.hotelsCollapsible).toBe(true)
    expect(layout({ results, proposal: trip, hotelsExpanded: true }).hotelsOpen).toBe(true)
  })

  it('promises the trip summary while the stay choice is in flight, and never a list with it', () => {
    const l = layout({ results, pending: chooseHotel, proposal: proposal({ decision: 'accept' }) })
    expect(l.skeleton).toBe('trip')
    expect(l.chosenHotel).toBe('H1')
    // No hotels placeholder beside it, and no second promise about the same click.
    expect(l.skeleton).not.toBe('hotels')
  })

  it('shows the reviewer\'s issues when the gates shipped it unapproved', () => {
    const flagged = { ...trip, gateOutcome: 'shipped_unapproved' as const, reviewIssues: ['the stay is far out'] }
    expect(layout({ results, proposal: flagged }).issues).toEqual(['the stay is far out'])
    expect(layout({ results, proposal: trip }).issues).toEqual([])
  })

  it('says the hand-off is running from the tick she presses Accept', () => {
    const l = layout({ results, proposal: trip, pending: { kind: 'accept', label: '', at: 0, sourceId: 'p2' } })
    expect(l.action).toBe('working')
  })
})

describe('the accepted stage', () => {
  const results = [row('flights', 'm1', ['F1']), row('hotels', 'm2', ['H1'])]
  const accepted = proposal({
    id: 'p2', decision: 'accept', items: [proposal().items[0]!, STAY], totalMinor: '300',
    links: [
      { itemId: 'F1', url: 'https://kiwi.example/F1', quotedMinor: '100', currency: 'EUR' },
      { itemId: 'H1', url: 'https://stay.example/H1', quotedMinor: '200', currency: 'EUR' },
    ],
  })

  it('takes the Change buttons away and offers the links', () => {
    const l = layout({ results, proposal: accepted, acceptedProposal: accepted })
    expect(l.stage).toBe('accepted')
    expect(l.changeable).toBe(false)
    expect(l.action).toBe('book')
    // Past choosing: neither list is offered, however she left them.
    expect(l.hotelsOpen).toBe(false)
    expect(l.hotelsCollapsible).toBe(false)
    expect(l.flightsOpen).toBe(false)
    expect(layout({
      results, proposal: accepted, acceptedProposal: accepted,
      flightsExpanded: true, hotelsExpanded: true,
    }).flightsOpen).toBe(false)
    expect(l.totals).toBe(true)
  })

  it('says what is happening while the cashier is still re-checking the prices', () => {
    const noLinks = { ...accepted, links: [] }
    const l = layout({ results, proposal: noLinks, acceptedProposal: noLinks, status: 'working' })
    expect(l.action).toBe('working')
  })

  /*
   * The browser harness sat in front of `Checking prices and getting your booking links…` for
   * three minutes while the office had already finished: the stay sold out between her accept
   * and the cashier's re-quote, and the desk had asked her which replacement to take. The turn
   * is over, so the pane must stop claiming it is still working and point at the question.
   */
  it('stops claiming to be working once the turn has finished without links', () => {
    const noLinks = { ...accepted, links: [] }
    const l = layout({ results, proposal: noLinks, acceptedProposal: noLinks, status: 'awaiting_user' })
    expect(l.action).toBe('answer')
  })

  /*
   * The cashier found an item sold out and swapped it, which writes a NEWER undecided proposal
   * after the accepted one. The newest is what the cards and the total describe, the changed
   * item carries a badge, and the primary asks for her word on the replacement.
   */
  it('asks again when an item was replaced', () => {
    const swapped = proposal({
      id: 'p3', decision: null, totalMinor: '320',
      items: [proposal().items[0]!, { ...STAY, sourceId: 'H2', name: 'Another stay' }],
    })
    const l = layout({ results, proposal: swapped, acceptedProposal: accepted })
    expect(l.stage).toBe('accepted')
    expect(l.action).toBe('accept_updated')
    expect(l.updatedSlots).toEqual(['stay'])
    expect(UPDATED_REASON).toBe('Sold out; replaced')
  })

  it('offers a way out when the turn failed', () => {
    const l = layout({ results, proposal: accepted, acceptedProposal: accepted, status: 'failed' })
    expect(l.action).toBe('retry')
  })

  /*
   * The hand-off failed after the decision was already durable, so a second `decide` is a 409
   * and nothing else. `Try again` asks the desk, in her own words, to try the links again — a
   * request the driver can act on with the tool it already has.
   */
  it('says what went wrong in the status line\'s own words', () => {
    expect(failWords('provider_down')).toBe('Something went wrong: a travel provider was unavailable.')
    expect(failWords('deadline_exceeded')).toBe('Something went wrong: the turn took too long.')
    // A code this office has not been taught yet falls back to itself rather than to silence.
    expect(failWords('something_new')).toBe('Something went wrong: something_new.')
    expect(failWords(null)).toBe('That turn did not finish.')
  })

  /*
   * `handleChooseFlight` records a flights-only proposal and accepts it on the spot. That is how
   * the office remembers the flight, not a decision about a trip — and reading it as one is what
   * put a second `Proposed trip` card in the chat at 16.23.
   */
  it('is not reached by the flights-only proposal the office accepts for itself', () => {
    const l = layout({ results, proposal: proposal({ decision: 'accept' }) })
    expect(l.stage).toBe('hotels')
    expect(l.action).toBe('none')
  })
})
