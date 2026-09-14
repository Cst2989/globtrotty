import { loadGoldenCases } from '../src/evals/cases.js'
import { rate } from '../src/evals/scorecard.js'
import { EVAL_TODAY, passAtK, passAtKRows, RECORDED_WORLD_SEED, seedFor } from '../src/evals/variance.js'
import { travelWindowFrom } from '../src/gates/notebookConstraints.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { applyRequirements, emptyNotebook } from '../src/notebook.js'
import { SEATS } from '../src/seats.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { HotelSearch } from '../src/supplier/types.js'

const AT = '2026-08-29T10:00:00Z'
const stay = (checkIn: string, checkOut: string): HotelSearch => ({
  kind: 'hotel', query: 'Faro', checkIn, checkOut, adults: 2, currency: 'EUR',
})

describe('what moves between two runs of one case, and what no longer does', () => {
  it('gives one world per case, however the desk phrases its searches', async () => {
    // The inversion of the case this lesson opened on. The mock still hashes
    // the search string, and the seed is mixed in first (src/supplier/mock.ts),
    // so the world belongs to the case rather than to the sentence the desk
    // happened to compose.
    const seed = seedFor('portugal-toddler-01')
    const monday = await mockSuppliers({ hotel: { seed } }).hotel.search(stay('2026-09-19', '2026-09-26'))
    const again = await mockSuppliers({ hotel: { seed } }).hotel.search(stay('2026-09-19', '2026-09-26'))
    expect(again.map((i) => i.price.minor)).toEqual(monday.map((i) => i.price.minor))
    // And a different case is a different world, so one case's fares can never
    // be mistaken for another's in a scorecard.
    const other = await mockSuppliers({ hotel: { seed: seedFor('hotel-only-02') } })
      .hotel.search(stay('2026-09-19', '2026-09-26'))
    expect(other.map((i) => i.sourceId)).not.toEqual(monday.map((i) => i.sourceId))
  })

  it('plans from its own calendar, which TODAY cannot move', () => {
    const nb = applyRequirements(emptyNotebook(), { month: 'September', nights: 7 }, 'user', AT).next
    // EVAL_TODAY and TODAY hold the same string today and are two constants, so
    // the lesson that moves TODAY moves the reader's transcript and not the
    // suite's anchor.
    expect(travelWindowFrom(nb, EVAL_TODAY)).toEqual(travelWindowFrom(nb, '2026-08-29'))
    expect(EVAL_TODAY).not.toBe('')
  })

  it('replays a recorded case in the world its recording was made in', () => {
    // The bill this lesson leaves, written as an assertion rather than as a
    // sentence in a residual nobody runs. `seedFor` gives a case a world of its
    // own, and the three recordings on this branch were made before it existed,
    // in MockConfig's default world, with the model's own `propose_trip` naming
    // the ids IT saw there. Replaying those responses in any other world fails
    // the provenance gate on every proposal, correctly, so the eval run passes
    // RECORDED_WORLD_SEED and the re-recording is owed.
    expect(RECORDED_WORLD_SEED).toBe(1)
    for (const kase of loadGoldenCases()) {
      expect(seedFor(kase.id)).not.toBe(RECORDED_WORLD_SEED)
    }
  })

  it('has no way to tell one set of weights from the next, by string', () => {
    // LL3 section 19: response.model echoes the ALIAS you sent, and
    // claude-opus-5 is alias only. The only record of what we intended is the
    // configuration id, and lesson 5.6's canary is already pinned against it.
    expect(SEATS.driver.model).toBe('claude-opus-5')
    expect(SEATS.driver.modelConfigId).toContain('claude-opus-5/')
  })

  it('runs twenty cases three times under the ceilings production runs under', () => {
    // Sixty conversations against DEFAULT_LIMITS. The per-user daily ceiling is
    // $15 and there is one eval "user" today, so the nightly suite is capped
    // long before it finishes, and the global ceiling is shared with her.
    // Thirty cents a conversation is a deliberate underestimate, and the
    // measurement is on this branch: `no-for-1500-03` replays ninety-six model
    // calls and costs about $1.57, which is five times the number below.
    const nightly = 20 * 3
    const perConversationMicros = 300_000n
    expect(BigInt(nightly) * perConversationMicros).toBeGreaterThan(DEFAULT_LIMITS.dailyCeilingMicros)
    expect(loadGoldenCases().length).toBeLessThan(nightly)
  })
})

describe('pass^k', () => {
  it('calls a case that passed every run passed, and not flaky', () => {
    expect(passAtK({ caseId: 'a', passed: [true, true, true] }))
      .toEqual({ caseId: 'a', k: 3, passes: 3, passedEvery: true, flaky: false })
  })

  it('calls two of three flaky, which is information and not noise', () => {
    const out = passAtK({ caseId: 'a', passed: [true, false, true] })
    expect(out.flaky).toBe(true)
    expect(out.passedEvery).toBe(false)
  })

  it('calls a case that failed every run failed, and not flaky', () => {
    // Consistently wrong is a bug. Inconsistently wrong is an unpinned input,
    // and the two want different work, so the scorecard must not merge them.
    expect(passAtK({ caseId: 'a', passed: [false, false, false] }).flaky).toBe(false)
  })

  it('prints k as the denominator on every row', () => {
    expect(rate(passAtKRows([passAtK({ caseId: 'a', passed: [true, false, true] })])[0]!.tally))
      .toBe('2/3 (67%)')
  })
})
