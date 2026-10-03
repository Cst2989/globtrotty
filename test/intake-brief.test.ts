import { describe, it, expect } from 'vitest'
import tokyo from './fixtures/jev/tokyo.json' with { type: 'json' }
import { assembleBrief } from '../src/intake/brief.js'
import { tripTitle } from '../src/agents/intake.js'
import { placeCandidates, datePartCandidates, countCandidates } from '../src/intake/candidates.js'
import type { JevAnswer } from '../src/jev/client.js'

// The recorded fixture (test/fixtures/jev/tokyo.json) is one REAL Jev response to this exact
// message — see scripts/record-jev.ts and task-5-report.md for how it was produced (re-recorded
// for task 5, after the outbound_day/arrive_by wording fix below, against the author's own message).
const MSG = 'i need to be in tokio with my wife on 20th of nov, from barcelona, and back in barcelona sunday 6th of december. i would like to fly on the long trips premium economie and on short economy, and for acomodation i am staying most of the time in tokio and i would like to visit everything turistic but not change a lot of hotels but i will also travel in kioto, i will visit the nintendo museum on the 3rd'
const today = new Date('2026-10-03T12:00:00Z')
const cands = { places: placeCandidates(MSG), dates: datePartCandidates(MSG), counts: countCandidates(MSG) }
// The JSON import attribute type-checks each field against the exact literal shape of this one
// fixture; widen it back to the real, open-ended answer type so the mutation tests below can
// swap in a different probability set, the way a genuinely variable Jev response would.
const answers = tokyo.answers as unknown as Record<string, JevAnswer>

describe('assembleBrief', () => {
  it('builds a complete brief from the Tokyo message with the year assumed and arrival moved a day earlier', () => {
    const out = assembleBrief(answers, cands, today, null)
    expect(out.kind).toBe('brief')
    if (out.kind !== 'brief') return
    expect(out.brief).toMatchObject({ origin: 'BCN', destination: 'TYO', sideTrip: 'OSA', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2, cabinLong: 'premium_economy', cabinShort: 'economy', hotels: true, arriveBy: true })
    expect(out.brief.assumptions.map((a) => a.field)).toEqual(expect.arrayContaining(['year', 'outbound']))
  })
  // Task 5's wording fix (outbound_day now says "(arrival or departure)", same as
  // outbound_month already did; arrive_by now says the date is still the outbound date)
  // targeted exactly this message, which is explicit about an ARRIVAL deadline. Both land
  // comfortably above their gates in the re-recorded fixture: outbound_day at 1 (was ~0.84
  // before the fix) and arrive_by at 0.61 (just above the 0.6 noul gate) — asserted here so a
  // future prompt change that regresses either one fails loudly rather than silently.
  it('keeps outbound_day and arrive_by above their confidence gates after the wording fix', () => {
    expect((answers.outbound_day as { confidence: number }).confidence).toBeGreaterThanOrEqual(0.6)
    expect((answers.arrive_by as { noul: number }).noul).toBeGreaterThan(0.6)
    expect((answers.fixed_commitment as { noul: number }).noul).toBeGreaterThan(0.6)
  })
  it('returns a choice card when the destination is below 0.6 confidence', () => {
    const low = structuredClone(answers)
    low.destination = { type: 'choice', choice: 'TYO', confidence: 0.4, probabilities: { TYO: 0.4, OSA: 0.35, BCN: 0.15, none: 0.1 } }
    const out = assembleBrief(low, cands, today, null)
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    // BCN is ranked third by Jev but never offered: it is the resolved ORIGIN, and the other end
    // of the flight is never an answer to "where is the trip to?" (I4). Two options is inside
    // spec section 3's 2-to-4 range, so no fallback source fires.
    expect(out.options.map((o) => o.id)).toEqual(['TYO', 'OSA'])
    expect(out.options[0]!.label).toBe('Tokyo')
  })
  it('falls back to the last used origin, then to a choice card', () => {
    const noOrigin = structuredClone(answers)
    noOrigin.origin = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9, TYO: 0.1 } }
    expect(assembleBrief(noOrigin, cands, today, 'MAD').kind).toBe('brief')
    expect(assembleBrief(noOrigin, cands, today, null).kind).toBe('choices')
  })
  it('returns an outbound choice card when the day is below 0.6 confidence, with origin and destination still confident', () => {
    const lowDay = structuredClone(answers)
    lowDay.outbound_day = { type: 'choice', choice: '20', confidence: 0.3, probabilities: { '20': 0.3, '19': 0.2, '3': 0.2, '6': 0.1, unstated: 0.2 } }
    const out = assembleBrief(lowDay, cands, today, null)
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    expect(out.questionId).toBe('outbound')
    // Origin/destination were never in question: this is a confidence gap on the day alone.
    expect((lowDay.origin as { confidence: number }).confidence).toBeGreaterThanOrEqual(0.6)
    expect((lowDay.destination as { confidence: number }).confidence).toBeGreaterThanOrEqual(0.6)
    // dateOptions walks the code-found day/month candidates ('20', '6', '3' x 'november',
    // 'december') and stops at MAX_OPTIONS, in that order. The cap moved from 3 to 4 with the
    // 2-to-4 range (C2), which is why '2026-12-20' now appears.
    expect(out.options.map((o) => o.id)).toEqual(['2026-11-20', '2026-11-06', '2026-11-03', '2026-12-20'])
    expect(out.options).toHaveLength(4)
  })

  // ---- C2 / I4: a card always has 2 to 4 options, and never the other end of the flight ----

  // The review reproduced C2 with exactly this message: no place in the table, no stored last
  // origin, so `placeCandidates` is empty, Jev's own `origin` answer is `none`, and the old
  // `placeOptions` returned [] -> `ChoicesContentSchema` threw inside `buildAttachmentRows`
  // AFTER the Jev call was paid for, and her very first turn failed outright.
  const WARM = 'I want to go somewhere warm next month, just me'
  const warmCands = {
    places: placeCandidates(WARM), dates: datePartCandidates(WARM), counts: countCandidates(WARM),
  }
  const noAnswers = (): Record<string, JevAnswer> => ({
    origin: { type: 'choice', choice: 'none', confidence: 0.95, probabilities: { none: 0.95 } },
    destination: { type: 'choice', choice: 'none', confidence: 0.95, probabilities: { none: 0.95 } },
  })

  it('yields a usable choices card for "somewhere warm", not a throw (C2)', () => {
    expect(warmCands.places).toEqual([])        // the precondition the review reproduced
    const out = assembleBrief(noAnswers(), warmCands, today, null)
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    expect(out.questionId).toBe('origin')
    expect(out.options.length).toBeGreaterThanOrEqual(2)
    expect(out.options.length).toBeLessThanOrEqual(4)
    // The documented last resort with neither end of the flight known: Europe's busiest four.
    expect(out.options.map((o) => o.id)).toEqual(['LON', 'PAR', 'BCN', 'BER'])
    // Labels come from the place table, never a raw code.
    expect(out.options.map((o) => o.label)).toEqual(['London', 'Paris', 'Barcelona', 'Berlin'])
  })

  it('never offers the destination as the origin, and seeds the card from her region (I4)', () => {
    // "Flights to Tokyo in November": Jev ranks the same candidate list for every place
    // question, so the origin card used to offer [Tokyo] — one option, and the wrong one.
    const MSG2 = 'Flights to Tokyo in November'
    const c2 = { places: placeCandidates(MSG2), dates: datePartCandidates(MSG2), counts: countCandidates(MSG2) }
    const a: Record<string, JevAnswer> = {
      origin: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.6, TYO: 0.4 } },
      destination: { type: 'choice', choice: 'TYO', confidence: 0.95, probabilities: { TYO: 0.95, none: 0.05 } },
    }
    const out = assembleBrief(a, c2, today, null)
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    expect(out.questionId).toBe('origin')
    expect(out.options.map((o) => o.id)).not.toContain('TYO')
    expect(out.options.length).toBeGreaterThanOrEqual(2)
    // The anchor is the destination we DO know, so the fallback is Asia's busiest four, minus
    // Tokyo itself.
    expect(out.options.map((o) => o.id)).toEqual(['SEL', 'BKK', 'SIN'])
  })

  it('refuses origin === destination and falls to the origin card (I4)', () => {
    // The shape a click produces: `runIntake` forces the clicked option in at confidence 1.
    const a = structuredClone(answers)
    a.origin = { type: 'choice', choice: 'TYO', confidence: 1, probabilities: { TYO: 1 } }
    const out = assembleBrief(a, cands, today, null)
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    expect(out.questionId).toBe('origin')
    // And the option that caused it is not on the card, so the loop cannot repeat.
    expect(out.options.map((o) => o.id)).not.toContain('TYO')
  })

  it('refuses a stored last origin that equals the destination (I4)', () => {
    const noOrigin = structuredClone(answers)
    noOrigin.origin = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } }
    // TYO is the destination in the Tokyo fixture: a stored origin of TYO is not a usable
    // origin, so this falls to the card rather than searching TYO -> TYO.
    expect(assembleBrief(noOrigin, cands, today, 'TYO').kind).toBe('choices')
    expect(assembleBrief(noOrigin, cands, today, 'MAD').kind).toBe('brief')
  })

  it('offers her last origin on a destination card when nothing else is ranked', () => {
    const a = noAnswers()
    const out = assembleBrief(a, warmCands, today, 'MAD')
    // The origin resolved from the stored default, so this is the DESTINATION card.
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    expect(out.questionId).toBe('destination')
    expect(out.options.map((o) => o.id)).not.toContain('MAD')   // MAD is the origin now
    expect(out.options.length).toBeGreaterThanOrEqual(2)
  })

  it('offers 2 to 4 options on every card every fixture can produce', () => {
    // The invariant `ChoicesContentSchema.min(2).max(4)` now enforces, checked at the source
    // across every gap that can open a card: each place question, the date, and no answers at
    // all — with and without a stored origin.
    const gaps: Array<Record<string, JevAnswer>> = []
    for (const key of ['origin', 'destination', 'outbound_day', 'outbound_month'] as const) {
      const a = structuredClone(answers)
      a[key] = { type: 'choice', choice: 'unstated', confidence: 0.95, probabilities: { unstated: 0.95 } }
      gaps.push(a)
    }
    const fixtures: Array<[Record<string, JevAnswer>, typeof cands, string | null]> = [
      ...gaps.map((a) => [a, cands, null] as [Record<string, JevAnswer>, typeof cands, string | null]),
      ...gaps.map((a) => [a, cands, 'MAD'] as [Record<string, JevAnswer>, typeof cands, string | null]),
      [noAnswers(), warmCands, null],
      [noAnswers(), warmCands, 'MAD'],
      [{}, warmCands, null],
      [{}, cands, null],
    ]
    let cards = 0
    for (const [a, c, last] of fixtures) {
      const out = assembleBrief(a, c, today, last)
      if (out.kind !== 'choices') continue
      cards++
      expect(out.options.length, `${out.questionId} card`).toBeGreaterThanOrEqual(2)
      expect(out.options.length, `${out.questionId} card`).toBeLessThanOrEqual(4)
      expect(new Set(out.options.map((o) => o.id)).size).toBe(out.options.length)   // no duplicates
    }
    expect(cards).toBeGreaterThan(4)   // the loop actually exercised cards, not just briefs
  })
})

// M2: `conversations.title` had no writer at all after the Haiku front desk was retired, so the
// sidebar fell back to her first message and the page header to "New trip". Built in code from
// the brief — place-table city names and ISO dates, never a model call and never her words.
describe('tripTitle', () => {
  const base = {
    origin: 'BCN', destination: 'TYO', sideTrip: null, outbound: '2026-11-19', inbound: '2026-12-06',
    adults: 2, cabinLong: 'premium_economy' as const, cabinShort: 'economy' as const,
    maxStops: null, hotels: true, arriveBy: true, assumptions: [],
  }

  it('names both ends and both dates — the ruling\'s own example, verbatim', () => {
    expect(tripTitle(base)).toBe('Barcelona to Tokyo, 19 Nov to 6 Dec')
  })

  it('names one date for a one-way', () => {
    expect(tripTitle({ ...base, inbound: null })).toBe('Barcelona to Tokyo, 19 Nov')
  })

  it('uses the place table\'s city names, so an unknown code degrades to the code itself', () => {
    expect(tripTitle({ ...base, origin: 'ZZZ' })).toBe('ZZZ to Tokyo, 19 Nov to 6 Dec')
  })
})
