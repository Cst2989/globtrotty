import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { checkDates } from '../src/gates/checks.js'
import { constraintsFromNotebook, travelWindowFrom } from '../src/gates/notebookConstraints.js'
import { NOT_EVALUATED, runGates } from '../src/gates/pipeline.js'
import { rehydrateRefs } from '../src/gates/rehydrateGate.js'
import { proposalRunner } from '../src/gates/runner.js'
import { GATE_NAMES } from '../src/gates/types.js'
import { submitMessage } from '../src/handler.js'
import { money } from '../src/money.js'
import { applyRequirements, emptyNotebook, type Notebook } from '../src/notebook.js'
import { recordResults } from '../src/repo/toolResults.js'
import { claimTurn, type Claim } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch, SupplierItem } from '../src/supplier/types.js'
import { flightSearchFrom, itemForModel } from '../src/tools.js'
import type { NotebookConstraints } from '../src/gates/pipeline.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()
const NOW = new Date('2026-08-16T12:00:00Z')
const FOUR_HOURS_AGO = new Date(NOW.getTime() - 4 * 3600_000)

const stay: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const notebook: NotebookConstraints = {
  budget: money(1_000_000n, 'EUR'),
  window: { earliest: '2026-09-01', latest: '2026-09-30' },
  currency: 'EUR',
}

/**
 * A conversation with a claimed, running turn on it.
 *
 * `recordResults` is a fenced write (lesson 4.3): it appends only while
 * `course.turns` shows this turn `running` at this claim's `attempts`, so a
 * corpus row belonging to nobody is not a state a test can produce. This is the
 * same `submitMessage` then `claimTurn` pair `test/gate-rehydrate.test.ts` and
 * `test/toolResults.test.ts` use, for the same reason. The claim comes back out
 * because a caller appending a SECOND fetch has to append it under the same one.
 */
async function claimedTurn(sql: postgres.Sql): Promise<Claim> {
  const submitted = await submitMessage(
    handlerDeps(sql),
    { userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: randomUUID() },
  )
  return (await claimTurn(sql, submitted.turnId!))!
}

describeDb('what the rehydration gate lets through, before this lesson', () => {
  it('says yes to a stale hotel, priced in dollars, standing in for an outbound flight', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      const conversationId = claim.conversationId

      // A supplier that answers in a currency nobody asked for, stamped four
      // hours ago against a fifteen-minute freshness window.
      const items = await mockSuppliers({ hotel: { currency: 'USD', now: () => FOUR_HOURS_AGO } })
        .hotel.search(stay)
      await recordResults(sql, claim, { params: stay, items })

      const res = await rehydrateRefs(sql, conversationId, [
        // A hotel, in the slot a flight goes in, sixteen of them.
        { sourceId: items[0]!.sourceId, quantity: 16, slot: 'outbound' },
      ])

      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      // The price is real, it is four hours old, it is dollars, and the line
      // total is sixteen times a price that already covered the whole stay.
      expect(res.items[0]!.item.price.currency).toBe('USD')
      expect(NOW.getTime() - res.items[0]!.item.fetchedAt.getTime())
        .toBeGreaterThan(res.items[0]!.item.ttlSeconds * 1000)
      expect(res.items[0]!.lineTotal.minor).toBe(res.items[0]!.item.price.minor * 16n)
      // Against a budget of 1,500 EUR, which nothing has looked at.
      expect(money(150000n, 'EUR').currency).not.toBe(res.items[0]!.lineTotal.currency)
    })
  })
})

/**
 * Every conversation is seeded with a DISTINCT `departureDate`, because
 * MockSupplier derives every sourceId from a hash of the search alone, and the
 * only fields that hash reads are `seed:from:to:departureDate`
 * (src/supplier/mock.ts). Seeding two conversations from one literal params
 * object gives them the SAME sourceIds, and a conversation-scoping test then
 * passes without regard to whether the code scopes anything. `flexDays` would
 * not fix that: it travels in the recorded search and never reaches the hash.
 *
 * `n` stays under 30, so every date is a real September day and lands inside
 * the `notebook` window below; the one test that wants a dates violation
 * supplies an October window instead of moving the departure.
 */
async function seed(sql: postgres.Sql, n: number, at = NOW, over: Partial<FlightSearch> = {}) {
  const claim = await claimedTurn(sql)
  const seeded: FlightSearch = { ...params, departureDate: `2026-09-${String(n).padStart(2, '0')}`, ...over }
  const items = await mockSuppliers({ flight: { now: () => at } }).flight.search(seeded)
  await recordResults(sql, claim, { params: seeded, items })
  return { claim, conversationId: claim.conversationId, items }
}

/**
 * Adds a second search to an EXISTING conversation, so one proposal can span
 * both. It appends under the SAME claim, because `recordResults` is fenced on
 * the running turn and a second fetch is the same turn searching again.
 *
 * `mutate` is how a test gets a corpus row MockSupplier cannot produce (it
 * quotes every item `priceBasis: 'total'`) without hand-writing an insert that
 * would bypass `recordResults` and stop testing the real write path.
 */
async function alsoSeed(
  sql: postgres.Sql, claim: Claim, over: Partial<FlightSearch>,
  mutate: (i: SupplierItem) => SupplierItem = (i) => i, at = NOW,
) {
  const seeded: FlightSearch = { ...params, ...over }
  const raw = await mockSuppliers({ flight: { now: () => at, currency: over.currency } }).flight.search(seeded)
  const items = raw.map(mutate)
  await recordResults(sql, claim, { params: seeded, items })
  return items
}

type GateRow = { gate: string; passed: boolean | null; detail: string | null; source_ids: string[] }

async function gateRows(sql: postgres.Sql, conversationId: string): Promise<Map<string, GateRow>> {
  const rows = await sql<GateRow[]>`
    select gate, passed, detail, source_ids from course.gate_results
     where conversation_id = ${conversationId} order by gate`
  return new Map(rows.map((r) => [r.gate, r]))
}

function withField<K extends keyof Notebook>(nb: Notebook, key: K, value: unknown): Notebook {
  return { ...nb, [key]: { value, source: 'user', at: '2026-08-16T12:00:00.000Z' } } as Notebook
}

describe('constraintsFromNotebook', () => {
  it('takes both the budget and the trip currency from the ONE budget field', () => {
    const c = constraintsFromNotebook(
      withField(emptyNotebook(), 'budget', money(250_000n, 'EUR')), '2026-08-29')
    expect(c.budget!.minor).toBe(250_000n)
    expect(c.currency).toBe('EUR')
  })

  it('reports a null currency when no budget is set, never a default of EUR', () => {
    const c = constraintsFromNotebook(emptyNotebook(), '2026-08-29')
    expect(c.budget).toBeNull()
    expect(c.currency).toBeNull()
  })

  it('derives a travel window from the month and the nights, and none without a month', () => {
    // Inverted at lesson 5.2. This case used to assert two nulls and state that
    // a window built from month plus nights would be the gate asserting an
    // itinerary she never stated. That is still true of the window's WIDTH and
    // it was the wrong conclusion, because the alternative was `passed: null`
    // on every proposal the branch had ever judged.
    let nb = withField(emptyNotebook(), 'month', 'September')
    nb = withField(nb, 'nights', 7)
    expect(constraintsFromNotebook(nb, '2026-08-29').window)
      .toEqual({ earliest: '2026-09-01', latest: '2026-10-07' })
    expect(constraintsFromNotebook(emptyNotebook(), '2026-08-29').window).toBeNull()
  })
})

describe('the window we can derive', () => {
  const AT = '2026-08-29T10:00:00Z'

  it('takes the next September when she writes in August', () => {
    const { next } = applyRequirements(emptyNotebook(), { month: 'September', nights: 7 }, 'user', AT)
    const w = travelWindowFrom(next, '2026-08-29')!
    expect(w.earliest).toBe('2026-09-01')
    // Thirty days in September plus seven nights.
    expect(w.latest).toBe('2026-10-07')
  })

  it('takes next year when the month has already passed', () => {
    const { next } = applyRequirements(emptyNotebook(), { month: 'March', nights: 3 }, 'user', AT)
    expect(travelWindowFrom(next, '2026-08-29')!.earliest.slice(0, 4)).toBe('2027')
  })

  it('returns null when she named no month, so the gate still refuses to evaluate', () => {
    // Wide is better than nothing. Invented is not: with no month at all there
    // is nothing to widen, and a window from a default would be the system
    // stating a trip she never described.
    expect(travelWindowFrom(emptyNotebook(), '2026-08-29')).toBeNull()
  })

  it('rejects a March proposal against a September window', () => {
    // The failure that has passed the dates gate on every run this branch has
    // ever made, because the window was null and the gate recorded a reason
    // instead of a verdict.
    const { next } = applyRequirements(emptyNotebook(), { month: 'September', nights: 7 }, 'user', AT)
    const item = {
      sourceId: 'flight-0-1111', supplier: 'mock', kind: 'flight' as const, name: 'BER to FAO',
      price: money(17_800n, 'EUR'), priceBasis: 'total' as const,
      fetchedAt: new Date('2026-08-29T09:00:00Z'), ttlSeconds: 3_600, bookingUrl: null,
      detail: { kind: 'flight' as const, outbound: { departureLocal: '2027-03-14T07:45' } } as never,
    }
    const out = checkDates([{ ref: { sourceId: item.sourceId, quantity: 1, slot: 'outbound' },
                              item, lineTotal: item.price }],
                           travelWindowFrom(next, '2026-08-29'))
    expect(out).toHaveLength(1)
    expect(out[0]!.gate).toBe('dates')
    expect(out[0]!.detail).toContain('2026-09-01')
    expect(out[0]!.sourceIds).toEqual(['flight-0-1111'])
    console.log(out[0]!.detail)
  })
})

describeDb('runGates', () => {
  it('passes a clean proposal and returns a total computed from the corpus, not the model', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 1)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: items[1]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      // Two DIFFERENT corpus prices, summed. The pair is what pins that the
      // total is built from the corpus rather than echoed from one item:
      // the seeded prices differ, so returning either alone fails here.
      expect(res.total.minor).toBe(items[0]!.price.minor + items[1]!.price.minor)
      expect(res.total.currency).toBe('EUR')
      expect(res.items[0]!.item.price.minor).toBe(items[0]!.price.minor)
      expect(res.items[0]!.lineTotal.minor).toBe(items[0]!.price.minor)
    })
  })

  it('writes a gate_results row for every gate it ran, including the passes', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 2)
      await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      const rows = await sql<{ gate: string; passed: boolean | null; detail: string | null
                              round: number; proposal_id: string | null }[]>`
        select gate, passed, detail, round, proposal_id from course.gate_results
         where conversation_id = ${conversationId} order by gate`
      // Literal, deliberately, and NOT derived from GATE_NAMES: a set derived
      // from the constant would assert only that the code agrees with itself.
      // src/gates/types.ts says so at length. Leave it literal.
      expect(rows.map((r) => r.gate)).toEqual(
        ['budget', 'currency', 'dates', 'freshness', 'provenance', 'slots', 'totals'],
      )
      // Strictly true, never merely truthy, so a null cannot slip through here.
      // All seven, `dates` included: this test supplies a window through
      // `notebook`, so every gate really did run. The next test is the one that
      // takes the window away and pins the null.
      expect(rows.map((r) => r.passed))
        .toEqual([true, true, true, true, true, true, true])
      expect(rows.every((r) => r.round === 0 && r.proposal_id === null)).toBe(true)
    })
  })

  it('records the dates gate as not evaluated, because this notebook has no window', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 3)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW,
        notebook: { ...notebook, window: null },
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(true)
      const rows = await gateRows(sql, conversationId)
      // Not a pass. Counting a gate that never fired as a pass inflates its
      // pass rate, which is the first statistic module 6 reads off this table.
      expect(rows.get('dates')!.passed).toBeNull()
      expect(rows.get('dates')!.detail).toBe(NOT_EVALUATED.noWindow)
    })
  })

  it('records the provenance row with every id it rehydrated', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 4)
      await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: items[1]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      const rows = await gateRows(sql, conversationId)
      // A passing gate names nothing, except provenance, whose evidence IS the
      // set of ids it certified against the corpus.
      expect([...rows.get('provenance')!.source_ids].sort())
        .toEqual([items[0]!.sourceId, items[1]!.sourceId].sort())
    })
  })

  it('short-circuits on provenance and does not run the later gates', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, 5)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: 'GHOST', quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      const rows = await gateRows(sql, conversationId)
      // One row, not seven. There is nothing to check the freshness, currency,
      // slot or dates OF if the item does not exist, and a row for each of them
      // would be six claims about an item nobody has.
      expect([...rows.keys()]).toEqual(['provenance'])
      expect(rows.get('provenance')!.passed).toBe(false)
      expect(rows.get('provenance')!.source_ids).toEqual(['GHOST'])
      expect(rows.get('provenance')!.detail).toContain('GHOST')
    })
  })

  it('reports every deterministic violation in one pass, not one per round trip', async () => {
    await withTestDb(async (sql) => {
      // Seeded well in the past, so freshness fails, and a budget of one cent,
      // so budget fails too.
      const { conversationId, items } = await seed(sql, 6, new Date('2026-08-01T12:00:00Z'))
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW,
        notebook: { ...notebook, budget: money(1n, 'EUR') },
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      // Two faults, one reply. One violation per round trip would turn this
      // into two model calls, and a three-fault proposal into three.
      expect(res.violations.map((v) => v.gate).sort()).toEqual(['budget', 'freshness'])

      const rows = await gateRows(sql, conversationId)
      expect(rows.get('freshness')!.passed).toBe(false)
      expect(rows.get('budget')!.passed).toBe(false)
      // Both failed gates still let the rest run: totals summed fine, so it PASSED.
      expect(rows.get('totals')!.passed).toBe(true)
      expect(rows.get('provenance')!.passed).toBe(true)
      expect(rows.get('budget')!.detail).toContain('over the')
      expect(rows.get('freshness')!.source_ids).toEqual([items[0]!.sourceId])
    })
  })

  it('rejects a tampered payload at the schema before touching the corpus', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 7)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight', price: 1 }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      // Pins the KEY zod named, not the constant prefix of our own message: a
      // /reference/i regex is satisfied by the prefix and proves nothing.
      expect(res.violations[0]!.detail).toContain('price')
      // A structural fault names no source id, because there is no validated id
      // to name.
      expect(res.violations[0]!.sourceIds).toEqual([])
      expect([...(await gateRows(sql, conversationId)).keys()]).toEqual(['provenance'])
    })
  })

  it('rejects an unknown slot at the schema and names the vocabulary', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 8)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'a' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      for (const slot of ['outbound', 'inbound', 'flight', 'stay']) {
        expect(res.violations[0]!.detail).toContain(slot)
      }
    })
  })

  it('runs the slots gate: a flight proposed for the stay slot is rejected', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 9)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'stay' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['slots'])
      const rows = await gateRows(sql, conversationId)
      expect(rows.get('slots')!.passed).toBe(false)
      expect(rows.get('slots')!.detail).toContain('takes a hotel')
      // A wrong slot does not stop the money gates: the set still sums.
      expect(rows.get('totals')!.passed).toBe(true)
      expect(rows.get('budget')!.passed).toBe(true)
    })
  })

  it('rejects a quantity above 1 instead of multiplying a whole-booking price', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 10)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 2, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['totals'])
      expect(res.violations[0]!.detail).toContain('quantity must be 1')
      const rows = await gateRows(sql, conversationId)
      // Recorded as a totals FAILURE, not a pass and not a null.
      expect(rows.get('totals')!.passed).toBe(false)
      expect(rows.get('totals')!.detail).toContain('quantity above 1')
      // And budget could not be evaluated: there is no total to compare.
      expect(rows.get('budget')!.passed).toBeNull()
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noTotal)
    })
  })

  it('reports a mixed-currency proposal ONCE, not once per gate that noticed', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, items } = await seed(sql, 11)
      const usd = await alsoSeed(sql, claim, { departureDate: '2026-09-26', currency: 'USD' })
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: usd[0]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      // checkTotals delegates to checkCurrency. Calling checkCurrency again in
      // the pipeline would describe the identical fault twice, and the model
      // would have to guess whether it had one problem or two.
      expect(res.violations.map((v) => v.gate)).toEqual(['currency'])
      expect(res.violations[0]!.sourceIds).toEqual([usd[0]!.sourceId])
    })
  })

  it('does not deadlock a USD budget: the seam searches in her currency and the gate agrees', async () => {
    await withTestDb(async (sql) => {
      // The one fault the course's own EUR running example can never surface.
      // Were the seam still hard-coding EUR (lesson 4.1's TRIP_CURRENCY), this
      // notebook would expect USD, every corpus row would be EUR, and
      // checkCurrency would reject every proposal she is capable of making,
      // for ever, with no re-search able to clear it. Pinned here rather than
      // in test/tools.test.ts because the deadlock is a property of the seam
      // and the gate TOGETHER, and neither file alone can show it.
      const hers = constraintsFromNotebook(
        withField(emptyNotebook(), 'budget', money(1_000_000n, 'USD')), '2026-08-29')
      const search = flightSearchFrom(
        { from: 'BER', to: 'FAO', departureDate: '2026-09-23', returnDate: '2026-09-30',
          adults: 2, children: 0 },
        hers.currency,
      )
      expect(search.currency).toBe('USD')

      const claim = await claimedTurn(sql)
      const conversationId = claim.conversationId
      const items = await mockSuppliers({ flight: { now: () => NOW, currency: search.currency } })
        .flight.search(search)
      await recordResults(sql, claim, { params: search, items })

      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook: hers,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      expect(res.total.currency).toBe('USD')
      const rows = await gateRows(sql, conversationId)
      expect(rows.get('currency')!.passed).toBe(true)
      expect(rows.get('budget')!.passed).toBe(true)
    })
  })

  it('records totals as null when it NEITHER summed nor rejected, because the fault was currency\'s', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, items } = await seed(sql, 12)
      const usd = await alsoSeed(sql, claim, { departureDate: '2026-09-27', currency: 'USD' })
      await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: usd[0]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      const rows = await gateRows(sql, conversationId)
      // Neither gate may claim a pass it never earned...
      expect(rows.get('totals')!.passed).toBeNull()
      expect(rows.get('budget')!.passed).toBeNull()
      // ...and null must say WHICH kind of not-evaluated this is, because two
      // different nulls that read identically are one null.
      expect(rows.get('totals')!.detail).toBe(NOT_EVALUATED.noTotal)
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noTotal)
      expect(rows.get('currency')!.passed).toBe(false)
      // And every other gate still recorded its real verdict.
      expect(rows.get('provenance')!.passed).toBe(true)
      expect(rows.get('freshness')!.passed).toBe(true)
      expect(rows.get('slots')!.passed).toBe(true)
      expect([...rows.keys()]).toEqual(
        ['budget', 'currency', 'dates', 'freshness', 'provenance', 'slots', 'totals'],
      )
    })
  })

  it('records totals as FALSE when it rejected the set itself, on a mixed price basis', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, items } = await seed(sql, 13)
      // Same currency, so currency passes and only totals can be at fault.
      const preTax = await alsoSeed(sql, claim, { departureDate: '2026-09-28' },
        (i) => ({ ...i, priceBasis: 'pre_tax' }))
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: preTax[0]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['totals'])
      const rows = await gateRows(sql, conversationId)
      // It DID evaluate and it DID reject. Recording that as null would lose the
      // fault as surely as recording it as a pass: the mirror image.
      expect(rows.get('totals')!.passed).toBe(false)
      expect(rows.get('totals')!.detail).toContain('pre_tax')
      expect(rows.get('currency')!.passed).toBe(true)
      expect(rows.get('budget')!.passed).toBeNull()
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noTotal)
    })
  })

  it('runs the dates gate when a caller does supply a window', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 14)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW,
        notebook: { ...notebook, window: { earliest: '2026-10-01', latest: '2026-10-31' } },
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['dates'])
      const rows = await gateRows(sql, conversationId)
      expect(rows.get('dates')!.passed).toBe(false)
      expect(rows.get('dates')!.detail).toContain('2026-10-01')
    })
  })

  it('records a gate with NO constraint configured as not-evaluated, not as a pass', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 15)
      const res = await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW,
        notebook: { budget: null, window: null, currency: null },
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      expect(res.total.minor).toBe(items[0]!.price.minor)
      const rows = await gateRows(sql, conversationId)
      // A currency-less notebook still totals: the items agree with each other,
      // so this gate really did run and really did pass.
      expect(rows.get('totals')!.passed).toBe(true)
      expect(rows.get('currency')!.passed).toBe(true)
      // These two did NOT run, because there was no constraint to run against.
      expect(rows.get('budget')!.passed).toBeNull()
      expect(rows.get('dates')!.passed).toBeNull()
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noBudget)
      expect(rows.get('dates')!.detail).toBe(NOT_EVALUATED.noWindow)
      expect(NOT_EVALUATED.noBudget).not.toBe(NOT_EVALUATED.noTotal)
    })
  })

  // The silent-omission guard, pinned behaviourally as well as by construction:
  // add a name to GATE_NAMES without wiring it in and this fails, rather than
  // the row quietly not existing. "No row" is indistinguishable from "the gate
  // never ran", which is the precise failure gate_results exists to prevent.
  it('writes a row for EVERY name in GateName, with none left to a hand-kept list', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 16)
      await runGates(sql, {
        conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      const rows = await gateRows(sql, conversationId)
      expect([...rows.keys()].sort()).toEqual([...GATE_NAMES].sort())
      expect(GATE_NAMES.length).toBe(7)
    })
  })

  it('does not accept an id belonging to a different conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, 17)
      const b = await seed(sql, 18)
      const res = await runGates(sql, {
        conversationId: b.conversationId, userId: USER, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: a.items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      expect(res.violations[0]!.sourceIds).toEqual([a.items[0]!.sourceId])
    })
  })

  it('carries the turn id onto every row it writes', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, items } = await seed(sql, 19)
      // A SECOND turn, and it has to be a second one. The corpus rows carry the
      // seeding turn's id, so a runGates that read `turn_id` off a corpus row
      // instead of using the argument it was handed would pass here against the
      // seeding turn and be wrong about every proposal judged in a later one.
      // Passing the seeding turn back in would assert nothing but that the two
      // ids match.
      //
      // The seeding turn is closed first, because 0004's
      // `turns_one_active_per_conversation` lets a conversation hold one live
      // turn at a time. That is also the honest sequence: she searched, the
      // turn ended, she came back, and the proposal is judged in the turn she
      // came back in, against a corpus an earlier turn built.
      const closed = await sql`update course.turns set status = 'done', finished_at = now()
                                where id = ${claim.turnId} returning id`
      expect(closed).toHaveLength(1)
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId, message: 'propose that one', idempotencyKey: randomUUID() },
      )
      const second = (await claimTurn(sql, submitted.turnId!))!
      expect(second.turnId).not.toBe(claim.turnId)

      await runGates(sql, {
        conversationId, userId: USER, turnId: second.turnId, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      const rows = await sql`select turn_id from course.gate_results where conversation_id = ${conversationId}`
      // Module 6 joins these rows to the turn that produced them; a null here
      // would make every gate run anonymous. The count is asserted first
      // because `every` over no rows is true.
      expect(rows).toHaveLength(GATE_NAMES.length)
      expect(rows.every((r) => r.turn_id === second.turnId)).toBe(true)
    })
  })
})

describeDb('proposalRunner', () => {
  it('hands the model a server-computed total when the gates pass', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 20)
      const run = proposalRunner(
        sql,
        { conversationId, userId: USER, turnId: null, notebook, now: () => NOW },
        async () => ({ content: 'not reached', isError: true }),
      )
      const outcome = await run('propose_itinerary', {
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      }, 's1-b0')
      expect(outcome.isError).toBe(false)
      const body = JSON.parse(outcome.content) as
        { ok: boolean; proposalId: string; total: Record<string, string> }
      expect(body.ok).toBe(true)
      expect(body.total.minor).toBe(items[0]!.price.minor.toString())
      // The total reaches the model in the SAME shape as every other price on
      // this wire, compared against `itemForModel`'s own output rather than
      // against a key list written here: minor units for arithmetic AND the
      // formatted string, so a reply never has to divide by an exponent it
      // guessed. money.ts lists JPY at exponent 0 and KWD at 3, and the search
      // currency follows her budget from this lesson on, so a model applying
      // the usual cents rule to a bare `minor` is a 100x error waiting for its
      // first non-EUR trip.
      const onTheWire = itemForModel(items[0]!).price as Record<string, string>
      expect(Object.keys(body.total).sort()).toEqual(Object.keys(onTheWire).sort())
      expect(body.total.formatted).toBe(onTheWire.formatted)
      // The id the model quotes back to `hand_off_to_booking` (lesson 4.6). It
      // is the row's id and not a number the model chose, which is the whole
      // reason the cashier reads a stored proposal rather than an itinerary.
      expect(body.proposalId).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  it('writes no proposal row when the gates reject', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, 25)
      const run = proposalRunner(
        sql,
        { conversationId, userId: USER, turnId: null, notebook, now: () => NOW },
        async () => ({ content: 'not reached', isError: true }),
      )
      const outcome = await run('propose_itinerary', {
        refs: [{ sourceId: 'GHOST', quantity: 1, slot: 'flight' }],
      }, 's1-b0')
      expect(outcome.isError).toBe(true)
      // A rejected proposal is not something she can be asked to accept, so
      // there is nothing for the cashier's precondition to read. A row here
      // would be a proposal id the model could hand off against a set of
      // references the gates refused.
      expect(await sql`select 1 from course.proposals where conversation_id = ${conversationId}`)
        .toHaveLength(0)
    })
  })

  it('hands back every violation as an error result, not as a failed turn', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, 21)
      const run = proposalRunner(
        sql,
        { conversationId, userId: USER, turnId: null, notebook, now: () => NOW },
        async () => ({ content: 'not reached', isError: true }),
      )
      const outcome = await run('propose_itinerary', {
        refs: [{ sourceId: 'GHOST', quantity: 1, slot: 'flight' }],
      }, 's1-b0')
      // isError, so the model reads it and can fix it on its next step. A gate
      // rejection is not a fail reason and FAIL_REASONS does not grow one.
      expect(outcome.isError).toBe(true)
      const body = JSON.parse(outcome.content) as { violations: { gate: string }[] }
      expect(body.violations.map((v) => v.gate)).toEqual(['provenance'])
    })
  })

  it('runs the budget gate through the same call tier 3 makes, when the notebook has one', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, 24)
      // proposalRunner IS the seam tier 3 builds, and this drives it with a
      // real budget in the context: the same runGates call, reached the same
      // way, rejecting a trip that is over her number. Both drivers hand it an
      // EMPTY notebook today, so `budget: not evaluated` is the only verdict
      // either `npm run trip` or tier 3 can produce, and a reader who ran only
      // those would never see this gate fire. This is the case the lesson
      // points at when it says so.
      const tight: NotebookConstraints = { ...notebook, budget: money(1n, 'EUR') }
      const run = proposalRunner(
        sql,
        { conversationId, userId: USER, turnId: null, notebook: tight, now: () => NOW },
        async () => ({ content: 'not reached', isError: true }),
      )
      const outcome = await run('propose_itinerary', {
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      }, 's1-b0')
      expect(outcome.isError).toBe(true)
      const body = JSON.parse(outcome.content) as { violations: { gate: string; detail: string }[] }
      expect(body.violations.map((v) => v.gate)).toEqual(['budget'])
      expect(body.violations[0]!.detail).toContain('over the')
      const rows = await gateRows(sql, conversationId)
      // A real verdict on the row, not the NOT_EVALUATED.noBudget tier 3 writes.
      expect(rows.get('budget')!.passed).toBe(false)
      expect(rows.get('budget')!.detail).not.toBe(NOT_EVALUATED.noBudget)
    })
  })

  it('passes every other tool through untouched', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, 22)
      const run = proposalRunner(
        sql,
        { conversationId, userId: USER, turnId: null, notebook, now: () => NOW },
        async (name) => ({ content: `inner saw ${name}`, isError: false }),
      )
      expect((await run('search_flights', {}, 's1-b0')).content).toBe('inner saw search_flights')
    })
  })
})
