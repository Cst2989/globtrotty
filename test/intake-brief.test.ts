import { describe, it, expect } from 'vitest'
import tokyo from './fixtures/jev/tokyo.json' with { type: 'json' }
import { assembleBrief } from '../src/intake/brief.js'
import { placeCandidates, datePartCandidates, countCandidates } from '../src/intake/candidates.js'
import type { JevAnswer } from '../src/jev/client.js'

// The recorded fixture (test/fixtures/jev/tokyo.json) is one REAL Jev response to this exact
// message — see scripts/record-jev.ts and task-3-report.md for how it was produced.
const MSG = 'I need to already be in Tokyo by the 20th of November, in time for a work conference that starts the moment I land that morning. I will fly out from Barcelona with my wife; book premium economy for the long flights, economy is fine for the short hop over to Kyoto for a couple of days. Sort out hotels for us too. We are back in Barcelona on Sunday the 6th of December.'
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
})
