import { readFileSync } from 'node:fs'
import { loadGoldenCases } from '../src/evals/cases.js'
import { invocationClock } from '../src/evals/conversation.js'
import { rate } from '../src/evals/scorecard.js'
import { EVAL_TODAY, evalNow, passAtK, passAtKRows, RECORDED_WORLD_SEED, seedFor } from '../src/evals/variance.js'
import { checkFreshness } from '../src/gates/checks.js'
import { travelWindowFrom } from '../src/gates/notebookConstraints.js'
import type { RehydratedItem } from '../src/gates/types.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { money } from '../src/money.js'
import { applyRequirements, emptyNotebook } from '../src/notebook.js'
import { SEATS } from '../src/seats.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { HotelSearch, SupplierItem } from '../src/supplier/types.js'

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
    // Written out rather than computed by the same function on the other side of
    // the assertion, so this goes red if EVAL_TODAY moves rather than agreeing
    // with itself whatever it holds.
    expect(travelWindowFrom(nb, EVAL_TODAY)).toEqual({ earliest: '2026-09-01', latest: '2026-10-07' })
    // The day a lesson moves TODAY to December, the reader's own window is a
    // year further out. The suite's is not, because the two are two constants.
    expect(travelWindowFrom(nb, '2026-12-01')).toEqual({ earliest: '2027-09-01', latest: '2027-10-07' })
  })

  it('renders the desk prompt from the caller calendar and not the module constant', () => {
    // Half a pin is worse than none. Until this lesson's fix round `makeDriver`
    // rendered `{{today}}` off module-scope `TODAY` (src/agents/driver.ts) while
    // the gates read `EVAL_TODAY`, so the day those two constants part company a
    // live eval would have the desk planning one year and the dates gate judging
    // another, and the gate would fail proposals the desk was right to make.
    // Invisible on the replayed path, because `replayClient` matches on the model
    // and ignores the prompt, which is exactly why it is asserted here.
    const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const file of ['src/agents/driver.ts', 'src/evals/conversation.ts', 'src/evals/runner.ts']) {
      expect(read(file)).not.toMatch(/^import \{[^}]*\bTODAY\b[^}]*\} from/m)
    }
    expect(read('src/agents/driver.ts')).toContain('{ today: deps.today }')
  })

  it('replays a recorded case in the world its recording was made in', async () => {
    // The bill this lesson leaves, written as the mechanism rather than as a
    // sentence in a residual nobody runs. The three recordings were made before
    // the world was pinned, against an unseeded `mockSuppliers()`, and the
    // model's own `propose_trip` names the source ids IT saw there.
    const search = stay('2026-09-19', '2026-09-26')
    const recorded = await mockSuppliers({ hotel: { seed: RECORDED_WORLD_SEED } }).hotel.search(search)
    const unseeded = await mockSuppliers().hotel.search(search)
    expect(recorded.map((i) => i.sourceId)).toEqual(unseeded.map((i) => i.sourceId))
    for (const kase of loadGoldenCases()) {
      const own = await mockSuppliers({ hotel: { seed: seedFor(kase.id) } }).hotel.search(search)
      // Not one id survives the move, so replaying a recorded proposal in the
      // case's own world names ids no search in that conversation returned, and
      // the provenance gate refuses every one of them. That is why `evals/run.ts`
      // passes RECORDED_WORLD_SEED and why the re-recording is owed.
      expect(own.map((i) => i.sourceId)).not.toEqual(recorded.map((i) => i.sourceId))
    }
  })

  it('stamps a supplier item from the same clock the freshness gate reads', async () => {
    // The coupling `runCase` depends on and nothing asserted until now: the mock
    // stamps `fetchedAt` from the clock it is handed, and the gates age items
    // against `deps.now()`. Drop `now` from either supplier config and the two
    // clocks disagree, `age < 0` on every item, and the freshness gate refuses a
    // proposal in which nothing is stale.
    const [item] = await mockSuppliers({
      hotel: { seed: RECORDED_WORLD_SEED, now: evalNow },
    }).hotel.search(stay('2026-09-19', '2026-09-26'))
    expect(item!.fetchedAt.toISOString()).toBe(evalNow().toISOString())
    const rehydrated: RehydratedItem[] = [{
      ref: { sourceId: item!.sourceId, quantity: 1, slot: 'stay' },
      item: item as SupplierItem, lineTotal: money(item!.price.minor, item!.price.currency),
    }]
    expect(checkFreshness(rehydrated, evalNow())).toEqual([])
    // The same item read against a clock that is not the one that stamped it.
    expect(checkFreshness(rehydrated, new Date('2026-08-28T10:00:00Z'))).toHaveLength(1)
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
    // measurement is on this branch: `no-for-1500-03` replays sixty-nine model
    // calls and costs about $0.99, which is more than three times the number below.
    const nightly = 20 * 3
    const perConversationMicros = 300_000n
    expect(BigInt(nightly) * perConversationMicros).toBeGreaterThan(DEFAULT_LIMITS.dailyCeilingMicros)
    expect(loadGoldenCases().length).toBeLessThan(nightly)
  })
})

describe("the eval's two clocks", () => {
  it('spends an invocation budget as real time passes', async () => {
    // `decideNext` hands a turn back when another step will not fit in what is
    // left of the invocation, and `withRetry` refuses a sleep that would cross
    // it. Both read `deadlineMs() - now()`, so both are dead arithmetic unless
    // that difference shrinks.
    const clock = invocationClock()
    const before = clock.deadlineMs() - clock.now()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(clock.deadlineMs() - clock.now()).toBeLessThan(before)
  })

  it('leaves the world where it was while the budget runs down', () => {
    // The other half, and the reason there are two clocks rather than one: the
    // instant a case is graded at does not move, however long the run takes.
    const first = evalNow().getTime()
    invocationClock().now()
    expect(evalNow().getTime()).toBe(first)
    expect(evalNow().toISOString()).toBe('2026-08-29T10:00:00.000Z')
  })

  it('hands the wall clock to both seats an eval calls', () => {
    // The three cases above prove `invocationClock` spends a real budget. They
    // prove nothing about who is given it, and reverting either seat to the
    // pinned clock left the whole suite green until this case existed. Both
    // seats use their clock for one thing only, the pair of readings `callModel`
    // subtracts for `latency_ms` (src/model/client.ts), so a pinned one writes a
    // zero: the driver's at src/agents/driver.ts and the scout's at
    // src/agents/scout.ts, and the three fixtures make 15, 0 and 15 scout calls.
    const src = readFileSync(new URL('../src/evals/conversation.ts', import.meta.url), 'utf8')
    // Comment lines stripped, because the docstrings quote the shape this
    // replaced and the assertion is about the code.
    const code = src.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n')
    expect(code).not.toContain('deps.now().getTime()')
    expect(code).toContain('now: clock.now')
    expect(code).toContain('chainFor(deps, ctx, clock.now)')
    // And domain time still reaches the wrappers that record facts about the
    // trip rather than about how long the process ran.
    expect(code).toContain('now: deps.now')
  })

  it('is what a frozen pair could not do', () => {
    // The shape this replaced, both before and after the clock was pinned: a
    // deadline recomputed from the current instant on every read is a constant
    // distance away for ever, so nothing can reach it.
    const rolling = { now: () => evalNow().getTime(), deadlineMs: () => evalNow().getTime() + 120_000 }
    expect(rolling.deadlineMs() - rolling.now()).toBe(120_000)
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
