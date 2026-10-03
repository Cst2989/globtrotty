import { describe, it, expect } from 'vitest'
import tokyo from './fixtures/jev/tokyo.json' with { type: 'json' }
import { assembleBrief } from '../src/intake/brief.js'
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
    expect(out.options.map((o) => o.id)).toEqual(['TYO', 'OSA', 'BCN'])
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
    // 'december') and stops at three, in that order.
    expect(out.options.map((o) => o.id)).toEqual(['2026-11-20', '2026-11-06', '2026-11-03'])
    expect(out.options).toHaveLength(3)
  })
})
