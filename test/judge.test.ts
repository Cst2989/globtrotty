import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { SENTINELS } from '../scripts/sentinels.js'
import {
  AGREEMENT_FLOOR, judgeAgreement, loadJudgePrompt, parseVerdict, runJudge, type Labelled,
} from '../src/evals/judge.js'
import type { GateOutcome, RehydratedItem } from '../src/gates/types.js'
import { sumMoney } from '../src/money.js'
import { SEATS } from '../src/seats.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { replayClient } from './model/replay.js'

describe('reading the judge', () => {
  it('reads a verdict and its one-sentence reason', () => {
    expect(parseVerdict('{"verdict":"fail","reason":"Two connections with a toddler."}'))
      .toEqual({ verdict: 'fail', reason: 'Two connections with a toddler.' })
  })

  it('reads a fenced block, because a model asked for JSON often sends one', () => {
    expect(parseVerdict('```json\n{"verdict":"pass","reason":"Direct flights, quiet street."}\n```')!.verdict)
      .toBe('pass')
  })

  it('returns null for a reply it cannot read, rather than calling it a fail', () => {
    // An unreadable reply is a check that did not run. Folding it into `fail`
    // would move the pass rate every time the model wrapped its answer in prose.
    expect(parseVerdict('I would say this one is fine, honestly.')).toBeNull()
    expect(parseVerdict('{"verdict":"maybe","reason":"hm"}')).toBeNull()
    expect(parseVerdict('{"verdict":"pass"}')).toBeNull()
  })

  it('runs on a seat that is not the seat it grades', () => {
    expect(SEATS.reviewer.model).not.toBe(SEATS.driver.model)
    expect(SEATS.reviewer.modelConfigId).not.toBe(SEATS.driver.modelConfigId)
  })

  it('loads its rubric from a file, versioned by the bytes it sends', () => {
    const raw = readFileSync(new URL('../src/evals/prompts/family-fit.md', import.meta.url), 'utf8')
    expect(raw).toContain('GLOBETROTTY-JUDGE-PROMPT-DO-NOT-SHIP')
    const loaded = loadJudgePrompt()
    // The marker and the sentinel are comments, so neither is on the wire, and
    // the version hashes what was SENT (src/desks.ts).
    expect(loaded.prompt).not.toContain('<!--')
    expect(loaded.prompt).toContain('family fit')
    expect(loaded.promptVersion).toMatch(/^[0-9a-f]{12}$/)
    // Every pattern, taken from the check itself rather than spelled again
    // here, on the scout prompt's precedent (test/scout.test.ts): a rubric the
    // judge can read back to the thing being judged is the one way to make a
    // judge useless, and a sentinel renamed in one place cannot be missed here.
    for (const s of SENTINELS) {
      expect(s.pattern.test(loaded.prompt), `the judge prompt sends ${s.name}`).toBe(false)
    }
  })
})

describe('calibrating against her decisions', () => {
  // A hand-written table, because the arithmetic is the thing under test and a
  // recorded judge reply would only pin the parser, which the cases above pin.
  const table = (pairs: [string, 'accept' | 'reject', 'pass' | 'fail'][]): Labelled[] =>
    pairs.map(([proposalId, decision, verdict]) => ({ proposalId, decision, verdict }))

  it('agrees when accept meets pass and reject meets fail', () => {
    expect(judgeAgreement(table([['a', 'accept', 'pass'], ['b', 'reject', 'fail']])))
      .toEqual({ agreed: 2, total: 2, meetsFloor: true })
  })

  it('refuses to deploy at seventy percent', () => {
    const rows = table([
      ['a', 'accept', 'pass'], ['b', 'accept', 'pass'], ['c', 'accept', 'pass'],
      ['d', 'accept', 'pass'], ['e', 'accept', 'pass'], ['f', 'accept', 'pass'],
      ['g', 'accept', 'pass'], ['h', 'reject', 'pass'], ['i', 'reject', 'pass'],
      ['j', 'reject', 'pass'],
    ])
    const out = judgeAgreement(rows)
    expect(out).toEqual({ agreed: 7, total: 10, meetsFloor: false })
    // A judge that disagrees with her is not a strict judge, it is a wrong one,
    // and the fix is the rubric rather than the users.
    expect(AGREEMENT_FLOOR).toBe(0.8)
  })

  it('passes at exactly the floor and not below it', () => {
    const at = table(Array.from({ length: 10 }, (_, i) =>
      [`p${i}`, 'accept', i < 8 ? 'pass' : 'fail'] as [string, 'accept', 'pass' | 'fail']))
    expect(judgeAgreement(at).meetsFloor).toBe(true)
    const below = table(Array.from({ length: 10 }, (_, i) =>
      [`p${i}`, 'accept', i < 7 ? 'pass' : 'fail'] as [string, 'accept', 'pass' | 'fail']))
    expect(judgeAgreement(below).meetsFloor).toBe(false)
  })

  it('treats an empty calibration set as a calibration nobody performed', () => {
    expect(judgeAgreement([])).toEqual({ agreed: 0, total: 0, meetsFloor: false })
  })
})

const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}
const FLIGHTS: FlightSearch = {
  kind: 'flight', from: 'LGW', to: 'FAO',
  departureDate: '2026-09-19', returnDate: '2026-09-26', flexDays: 0,
  adults: 2, children: 0, infants: 1, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

/**
 * A `GateOutcome` the gates would approve, built out of `mockSuppliers` the way
 * test/grade.test.ts builds its rehydrated items: the seed-1 world's third stay
 * is `Quinta da Ria` and its first flight is the direct one, which is the
 * rubric's own PASS example spelled in items rather than in prose.
 */
async function approvedOutcome(): Promise<GateOutcome> {
  const suppliers = mockSuppliers()
  const stays = await suppliers.hotel.search(STAY)
  const flights = await suppliers.flight.search(FLIGHTS)
  const stay = stays[2]!
  const flight = flights[0]!
  const items: RehydratedItem[] = [
    { ref: { sourceId: flight.sourceId, quantity: 1, slot: 'flight' }, item: flight, lineTotal: flight.price },
    { ref: { sourceId: stay.sourceId, quantity: 1, slot: 'stay' }, item: stay, lineTotal: stay.price },
  ]
  return { ok: true, items, total: sumMoney(items.map((i) => i.lineTotal)) }
}

/**
 * The recording this case replays, which is not in the tree at this commit.
 *
 * It is gated rather than assumed, and gated the way `describeDb`
 * (test/helpers/db.ts) and `describeLiveModel` (test/helpers/live.ts) gate: a
 * printed reason at module scope and a skip, because a fixture that is missing
 * has to read as a check nobody ran rather than as a red suite or, worse, as a
 * green one. `replayClient` throws on a missing file, so without this gate the
 * absence would land as a failure naming a path instead of a sentence naming
 * what is owed. The command that closes it is in README.md's residuals.
 *
 * `RECORD_MODEL=1` opens the gate, because a gate that skipped the one case
 * that writes the fixture would be a gate nobody could ever close: that is the
 * mode `replayClient` records in, and it needs to reach the call.
 */
const FIXTURE = new URL('./fixtures/model/judge-family-fit.json', import.meta.url)
const hasJudgeFixture = existsSync(FIXTURE) || process.env.RECORD_MODEL === '1'
if (!hasJudgeFixture) {
  console.warn(
    'No test/fixtures/model/judge-family-fit.json: skipping the replayed judge. Record it with '
  + 'RECORD_MODEL=1 and ANTHROPIC_API_KEY set. The judge\'s parse, its rubric and its agreement '
  + 'arithmetic are covered above and need no recording.',
  )
}
const describeReplayedJudge = hasJudgeFixture ? describeDb : describe.skip

describeReplayedJudge('the judge, replayed', () => {
  // What a recorded verdict can prove is the parse and the row: it pins one
  // afternoon's answer to one itinerary and says nothing whatever about the
  // judge's calibration, which is what `judgeAgreement` asserts above over a
  // table nobody recorded.
  it('returns a verdict and a reason, and prices its own call', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
      const client = replayClient('judge-family-fit')
      const verdict = await runJudge(
        { sql, client, ctx: { userId, conversationId: c!.id as string, turnId: null }, now: Date.now },
        await approvedOutcome(),
      )
      expect(verdict).not.toBeNull()
      expect(['pass', 'fail']).toContain(verdict!.verdict)
      expect(verdict!.reason.length).toBeGreaterThan(0)
      const rows = await sql<{ seat: string; model_config_id: string; cost_micros: string }[]>`
        select seat, model_config_id, cost_micros from course.model_calls where user_id = ${userId}`
      expect(rows[0]!.seat).toBe('reviewer')
      expect(rows[0]!.model_config_id).toBe(SEATS.reviewer.modelConfigId)
      expect(BigInt(rows[0]!.cost_micros)).toBeGreaterThan(0n)
      client.done()
    })
  })
})
