import { randomUUID } from 'node:crypto'
import { liveClient } from '../src/client.js'
import { judgeContext, runJudge } from '../src/evals/judge.js'
import { EVAL_LIMITS } from '../src/limits.js'
import type { GateOutcome, RehydratedItem } from '../src/gates/types.js'
import { sumMoney } from '../src/money.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'
import { DB_URL, withTestDb } from './helpers/db.js'
import { describeLiveModel, requireModelKey } from './helpers/live.js'

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
 * One approved itinerary, out of the seed-1 mock world, chosen by index.
 *
 * The indices are the whole of what separates the two cases below, and they are
 * not arbitrary: `MockSupplier` gives its i-th flight `i % 3` stops, so flight 0
 * is direct and flight 2 carries two connections each way, and its hotel names
 * cycle `Praia Guesthouse`, `Hotel Atlantico`, `Quinta da Ria`. So (2, 0) is the
 * quinta with direct flights, which is the rubric's PASS example, and (1, 2) is
 * a hotel reached by two connections, which breaks the rubric's connection rule.
 */
async function outcomeOf(stayIndex: number, flightIndex: number): Promise<GateOutcome> {
  const suppliers = mockSuppliers()
  const stay = (await suppliers.hotel.search(STAY))[stayIndex]!
  const flight = (await suppliers.flight.search(FLIGHTS))[flightIndex]!
  const items: RehydratedItem[] = [
    { ref: { sourceId: flight.sourceId, quantity: 1, slot: 'flight' }, item: flight, lineTotal: flight.price },
    { ref: { sourceId: stay.sourceId, quantity: 1, slot: 'stay' }, item: stay, lineTotal: stay.price },
  ]
  return { ok: true, items, total: sumMoney(items.map((i) => i.lineTotal)) }
}

/**
 * The live flag AND a database, because `runJudge` reserves against a
 * conversation and writes a `course.model_calls` row, and a Tier C file that
 * goes red for a missing DATABASE_URL is a file reporting a failure where it
 * means a skip.
 *
 * Both halves print their reason, and the second half prints its own rather
 * than relying on `describeLiveModel`. That helper (test/helpers/live.ts) warns
 * only when `LIVE_MODEL=1` is set WITHOUT a key. On the default run, where the
 * flag is unset, it is `describe.skip` and says nothing at all. An earlier
 * version of this comment claimed both reasons were already written down
 * somewhere a reader could find them, and on the run every reader actually
 * performs that was false, in the one file of this lesson whose whole subject is
 * that a suite which verified nothing must not read like a suite that verified.
 * So the line below is written at module scope, once, and only in the case it
 * describes, which is the house pattern `describeDb` and `describeLiveSearchApi`
 * both follow.
 */
const hasModelFlag = process.env.LIVE_MODEL === '1'
if (!hasModelFlag) {
  console.warn(
    'LIVE_MODEL is not set: skipping the live judge. These two cases are the only ones in the '
  + 'suite that call a model for real, and they cost money. Set LIVE_MODEL=1 with '
  + 'ANTHROPIC_API_KEY and DATABASE_URL to run them.',
  )
}
const describeLiveJudge = DB_URL ? describeLiveModel : describe.skip

describeLiveJudge('the judge on a real model', () => {
  it('fails an itinerary with two connections, and says which rule it broke', async () => {
    requireModelKey()
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
      const verdict = await runJudge(
        { sql, client: liveClient(), ctx: judgeContext({ userId, conversationId: c!.id as string }),
          limits: EVAL_LIMITS, now: Date.now },
        await outcomeOf(1, 2),
      )
      // A property and never the wording: the one fail rule this itinerary
      // breaks is the connection rule, `stops: 2` in each direction against a
      // limit of one, and the reason has to name it in one of the words the
      // rubric or the payload gives it.
      expect(verdict!.verdict).toBe('fail')
      expect(verdict!.reason.toLowerCase()).toMatch(/connection|stop|change|leg/)
    })
  }, 120_000)

  it('passes the quiet quinta with direct flights', async () => {
    requireModelKey()
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
      // The rubric's own PASS example, in items. Nothing here matches a fail
      // rule, and the rubric says in one sentence that a property it cannot
      // judge from what it was shown is a property it passes on, so a fail here
      // is the judge inventing a fault rather than finding one.
      const verdict = await runJudge(
        { sql, client: liveClient(), ctx: judgeContext({ userId, conversationId: c!.id as string }),
          limits: EVAL_LIMITS, now: Date.now },
        await outcomeOf(2, 0),
      )
      expect(verdict!.verdict).toBe('pass')
      expect(verdict!.reason.length).toBeGreaterThan(0)
    })
  }, 120_000)
})
