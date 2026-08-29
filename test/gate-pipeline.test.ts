import { expect, it, describe } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults } from '../src/repo/toolResults.js'
import { runGates } from '../src/gates/pipeline.js'
import { constraintsFromNotebook } from '../src/gates/notebookConstraints.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import type { FlightSearch, SupplierItem } from '../src/supplier/types.js'
import type { NotebookConstraints } from '../src/gates/pipeline.js'
import { GATE_NAMES } from '../src/gates/types.js'
import { NOT_EVALUATED } from '../src/gates/pipeline.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-08-16T12:00:00Z')
const notebook: NotebookConstraints = {
  budget: money(10_000_00n, 'EUR'),
  window: { earliest: '2026-09-01', latest: '2026-09-30' },
  currency: 'EUR',
}

/**
 * Every conversation is seeded with DISTINCT params (`flexDays`), because
 * `MockSupplier` derives every sourceId from `hash(JSON.stringify(params))`
 * alone. Seeding two conversations from one literal params object gives them
 * the SAME sourceIds, and a conversation-scoping test then passes without
 * regard to whether the code scopes anything. Same correction as
 * test/gate-rehydrate.test.ts.
 */
async function seed(sql: any, n: string, at = NOW, over: Partial<FlightSearch> = {}) {
  const userId = `00000000-0000-4000-8000-0000000003${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const conversationId = c!.id as string
  const seededParams: FlightSearch = { ...params, flexDays: Number(n), ...over }
  const items = await new MockSupplier({ kind: 'flight', now: () => at }).search(seededParams)
  await recordResults(sql, { conversationId, userId, turnId: null, params: seededParams, items })
  return { userId, conversationId, items }
}

/**
 * Adds a second search to an EXISTING conversation, so one proposal can span both.
 * `mutate` is how a test gets a corpus row MockSupplier cannot produce (it quotes
 * every item `priceBasis: 'total'`), without hand-writing an insert that would
 * bypass `recordResults` and stop testing the real write path.
 */
async function alsoSeed(
  sql: any, conversationId: string, userId: string, over: Partial<FlightSearch>,
  mutate: (i: SupplierItem) => SupplierItem = (i) => i, at = NOW,
) {
  const seededParams: FlightSearch = { ...params, ...over }
  const raw = await new MockSupplier({ kind: 'flight', now: () => at }).search(seededParams)
  const items = raw.map(mutate)
  await recordResults(sql, { conversationId, userId, turnId: null, params: seededParams, items })
  return items
}

type GateRow = { gate: string; passed: boolean | null; detail: string | null; source_ids: string[] }

async function gateRows(sql: any, conversationId: string): Promise<Map<string, GateRow>> {
  const rows = await sql<GateRow[]>`
    select gate, passed, detail, source_ids from gate_results
     where conversation_id = ${conversationId} order by gate`
  return new Map(rows.map((r: GateRow) => [r.gate, r]))
}

// ---------------------------------------------------------------------------
// The notebook adapter. Pure — no database.
// ---------------------------------------------------------------------------

function withField<K extends keyof Notebook>(nb: Notebook, key: K, value: unknown): Notebook {
  return { ...nb, [key]: { value, source: 'user', at: '2026-08-16T12:00:00.000Z' } } as Notebook
}

describe('constraintsFromNotebook', () => {
  it('takes both the budget and the trip currency from the ONE budget field', () => {
    const nb = withField(emptyNotebook(), 'budget', money(250_000n, 'EUR'))
    const c = constraintsFromNotebook(nb)
    expect(c.budget!.minor).toBe(250_000n)
    expect(c.budget!.currency).toBe('EUR')
    expect(c.currency).toBe('EUR')
  })

  it('reports a null currency when no budget is set — never a default of EUR', () => {
    const c = constraintsFromNotebook(emptyNotebook())
    expect(c.budget).toBeNull()
    expect(c.currency).toBeNull()
    expect(c.window).toBeNull()
  })

  it('builds the window from the exact departure and return dates', () => {
    let nb = withField(emptyNotebook(), 'departureDate', '2026-09-12')
    nb = withField(nb, 'returnDate', '2026-09-19')
    expect(constraintsFromNotebook(nb).window).toEqual({
      earliest: '2026-09-12', latest: '2026-09-19',
    })
  })

  it('yields NO window when the return date is missing — a half-open range is not invented', () => {
    const nb = withField(emptyNotebook(), 'departureDate', '2026-09-12')
    expect(constraintsFromNotebook(nb).window).toBeNull()
  })

  it('yields no window when only the return date is known', () => {
    const nb = withField(emptyNotebook(), 'returnDate', '2026-09-19')
    expect(constraintsFromNotebook(nb).window).toBeNull()
  })

  it('yields no window when the two dates are inverted', () => {
    let nb = withField(emptyNotebook(), 'departureDate', '2026-09-19')
    nb = withField(nb, 'returnDate', '2026-09-12')
    expect(constraintsFromNotebook(nb).window).toBeNull()
  })

  it('yields no window when a date is not a yyyy-mm-dd calendar date', () => {
    let nb = withField(emptyNotebook(), 'departureDate', '12/09/2026')
    nb = withField(nb, 'returnDate', '2026-09-19')
    expect(constraintsFromNotebook(nb).window).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------

describeDb('runGates', () => {
  it('passes a clean proposal and returns a total computed from the corpus, not the model', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '01')
      const real = items[0]!.price.minor
      const other = items[1]!.price.minor
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: items[1]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      // Two DIFFERENT corpus prices, summed. The pair is what pins that the
      // total is built from the corpus rather than echoed from one item: the
      // seeded prices differ, so returning either one alone fails here.
      // (This used to pin `price x 3` via a quantity-3 ref; quantity above 1 is
      // now a totals violation — see the test below.)
      expect(res.total.minor).toBe(real + other)
      expect(res.total.currency).toBe('EUR')
      expect(res.items[0]!.item.price.minor).toBe(real)
      expect(res.items[0]!.lineTotal.minor).toBe(real)
    })
  })

  /**
   * The `quantity` hole, end to end. The model controls this integer and the
   * server multiplies it into the total, so a `quantity: 16` proposal used to
   * come back with a 16x total and `gate_results` recording `totals: pass` —
   * a price the model effectively wrote, reaching the user through gates that
   * all said yes. Both shipped adapters price the whole booking (Kiwi quotes
   * the party total, SearchApi the whole stay), so 1 is the only correct
   * multiplier.
   *
   * Asserts the VIOLATION and the recorded row, deliberately not an inflated
   * total: checking `total === price x 2` would pass against the bug.
   */
  it('rejects a quantity above 1 instead of multiplying a whole-booking price', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '18')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 2, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['totals'])
      expect(res.violations[0]!.sourceIds).toEqual([items[0]!.sourceId])
      expect(res.violations[0]!.detail).toContain('quantity must be 1')

      // And it is recorded as a totals FAILURE, not a pass and not a null.
      const rows = await gateRows(sql, conversationId)
      expect(rows.get('totals')!.passed).toBe(false)
      expect(rows.get('totals')!.detail).toContain('quantity above 1')
      // budget could not be evaluated: there is no total to compare.
      expect(rows.get('budget')!.passed).toBeNull()
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noTotal)
    })
  })

  it('writes a gate_results row for every gate it ran, including the passes', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '02')
      await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      const rows = await sql<{ gate: string; passed: boolean | null; detail: string | null
                              round: number; proposal_id: string | null }[]>`
        select gate, passed, detail, round, proposal_id from gate_results
         where conversation_id = ${conversationId} order by gate`
      expect(rows.map((r) => r.gate)).toEqual(
        ['budget', 'currency', 'dates', 'freshness', 'provenance', 'slots', 'totals'],
      )
      // Strictly `true`, never merely truthy: `null` must not slip through here.
      expect(rows.map((r) => r.passed)).toEqual([true, true, true, true, true, true, true])
      expect(rows.every((r) => r.detail === null)).toBe(true)
      expect(rows.every((r) => r.round === 0 && r.proposal_id === null)).toBe(true)
    })
  })

  it('records the provenance row with every id it rehydrated', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '07')
      await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: items[1]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      const rows = await gateRows(sql, conversationId)
      expect(rows.get('provenance')!.source_ids.sort())
        .toEqual([items[0]!.sourceId, items[1]!.sourceId].sort())
    })
  })

  it('short-circuits on provenance and does not run the later gates', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, '03')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: 'GHOST', quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      expect(res.violations[0]!.sourceIds).toEqual(['GHOST'])
      const rows = await sql<{ gate: string; passed: boolean | null; detail: string | null
                              source_ids: string[] }[]>`
        select gate, passed, detail, source_ids from gate_results
         where conversation_id = ${conversationId}`
      expect(rows.map((r) => r.gate)).toEqual(['provenance'])
      expect(rows[0]!.passed).toBe(false)
      expect(rows[0]!.source_ids).toEqual(['GHOST'])
      expect(rows[0]!.detail).toContain('GHOST')
    })
  })

  it('reports every deterministic violation in one pass, not one per round trip', async () => {
    await withTestDb(async (sql) => {
      // Seeded well in the past: freshness fails. Budget of 1 cent: budget fails too.
      const old = new Date('2026-08-01T12:00:00Z')
      const { conversationId, items } = await seed(sql, '04', old)
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW,
        notebook: { ...notebook, budget: money(1n, 'EUR') },
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate).sort()).toEqual(['budget', 'freshness'])

      const rows = await gateRows(sql, conversationId)
      expect(rows.get('freshness')!.passed).toBe(false)
      expect(rows.get('budget')!.passed).toBe(false)
      // Both failed gates still ran the rest: totals summed fine, so it PASSED.
      expect(rows.get('totals')!.passed).toBe(true)
      expect(rows.get('dates')!.passed).toBe(true)
      expect(rows.get('provenance')!.passed).toBe(true)
      expect(rows.get('budget')!.detail).toContain('over the')
      expect(rows.get('freshness')!.source_ids).toEqual([items[0]!.sourceId])
    })
  })

  it('rejects a tampered payload at the schema before touching the corpus', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '05')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight', price: 1 },
        ],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      // Pins the KEY zod named, not the constant prefix of our own message: a
      // /reference/i regex is satisfied by the prefix and proves nothing.
      expect(res.violations[0]!.detail).toContain('price')
      expect(res.violations[0]!.sourceIds).toEqual([])
      const rows = await gateRows(sql, conversationId)
      expect([...rows.keys()]).toEqual(['provenance'])
      expect(rows.get('provenance')!.passed).toBe(false)
    })
  })

  it('rejects an unknown slot at the schema and names the vocabulary', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '08')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
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
      const { conversationId, items } = await seed(sql, '09')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'stay' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['slots'])
      const rows = await gateRows(sql, conversationId)
      expect(rows.get('slots')!.passed).toBe(false)
      expect(rows.get('slots')!.source_ids).toEqual([items[0]!.sourceId])
      expect(rows.get('slots')!.detail).toContain('takes a hotel')
      // A wrong slot does not stop the money gates: the set still sums.
      expect(rows.get('totals')!.passed).toBe(true)
      expect(rows.get('budget')!.passed).toBe(true)
    })
  })

  it('reports a mixed-currency proposal ONCE, not once per gate that noticed', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, userId, items } = await seed(sql, '10')
      const gbp = await alsoSeed(sql, conversationId, userId, { currency: 'GBP' })
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: gbp[0]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      // checkTotals delegates to checkCurrency. Calling checkCurrency again in
      // the pipeline would double-report the identical fault.
      expect(res.violations.filter((v) => v.gate === 'currency')).toHaveLength(1)
      expect(res.violations.map((v) => v.gate)).toEqual(['currency'])
      expect(res.violations[0]!.sourceIds).toEqual([gbp[0]!.sourceId])
    })
  })

  // The three verdicts the totals gate can reach, one test each. `totals` is
  // `null` ONLY when it neither summed nor rejected — recording a real
  // rejection as "not evaluated" is the exact mirror of the bug the null state
  // exists to prevent.
  it('totals is null when it NEITHER summed nor rejected — the fault was currency\'s', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, userId, items } = await seed(sql, '11')
      const gbp = await alsoSeed(sql, conversationId, userId, { currency: 'GBP' })
      await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: gbp[0]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      const rows = await gateRows(sql, conversationId)
      // Neither gate may claim a pass it never earned...
      expect(rows.get('totals')!.passed).toBeNull()
      expect(rows.get('budget')!.passed).toBeNull()
      // ...and `null` must say WHICH kind of not-evaluated this is.
      expect(rows.get('totals')!.detail).toBe(NOT_EVALUATED.noTotal)
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noTotal)
      expect(rows.get('currency')!.passed).toBe(false)
      // ... and every other gate still recorded its real verdict.
      expect(rows.get('provenance')!.passed).toBe(true)
      expect(rows.get('freshness')!.passed).toBe(true)
      expect(rows.get('slots')!.passed).toBe(true)
      expect(rows.get('dates')!.passed).toBe(true)
      expect([...rows.keys()]).toEqual(
        ['budget', 'currency', 'dates', 'freshness', 'provenance', 'slots', 'totals'],
      )
    })
  })

  it('totals is FALSE when it rejected the set itself — a mixed price basis', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, userId, items } = await seed(sql, '16')
      // Same currency, so `currency` passes and only `totals` can be at fault.
      const preTax = await alsoSeed(
        sql, conversationId, userId, { flexDays: 9 },
        (i) => ({ ...i, priceBasis: 'pre_tax' }),
      )
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [
          { sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' },
          { sourceId: preTax[0]!.sourceId, quantity: 1, slot: 'inbound' },
        ],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['totals'])
      const rows = await gateRows(sql, conversationId)
      // It DID evaluate and it DID reject. Recording that as null would lose
      // the fault — the mirror of recording an uncomputed total as a pass.
      expect(rows.get('totals')!.passed).toBe(false)
      expect(rows.get('totals')!.detail).toContain('pre_tax')
      expect(rows.get('currency')!.passed).toBe(true)
      // Budget still could not evaluate: there is no total to compare.
      expect(rows.get('budget')!.passed).toBeNull()
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noTotal)
    })
  })

  it('runs the dates gate against the notebook window', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '12')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW,
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
      const { conversationId, items } = await seed(sql, '13')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW,
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
      // These two did NOT run — there was no constraint to run them against.
      // Recording them as passes inflates the pass rate of a gate that never
      // fired, which is the first statistic slice 2 reads.
      expect(rows.get('budget')!.passed).toBeNull()
      expect(rows.get('dates')!.passed).toBeNull()
      // `null` now has two causes, so `detail` must say which. Exact text,
      // because two different nulls that read identically are one null.
      expect(rows.get('budget')!.detail).toBe(NOT_EVALUATED.noBudget)
      expect(rows.get('dates')!.detail).toBe(NOT_EVALUATED.noWindow)
      expect(NOT_EVALUATED.noBudget).not.toBe(NOT_EVALUATED.noTotal)
    })
  })

  // The silent-omission guard. `GateName` and the row set are derived from ONE
  // constant, so a gate added to the union cannot be forgotten by the writer —
  // but this pins the guarantee behaviourally too: add a name to `GATE_NAMES`
  // without wiring it in and this fails, rather than the row quietly not
  // existing. "No row" is indistinguishable from "the gate never ran", which is
  // the precise failure gate_results exists to prevent.
  it('writes a row for EVERY name in GateName, with none left to a hand-kept list', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '17')
      await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      const rows = await gateRows(sql, conversationId)
      expect([...rows.keys()].sort()).toEqual([...GATE_NAMES].sort())
      expect(GATE_NAMES.length).toBe(7)
    })
  })

  it('does not accept an id belonging to a different conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '14')
      const b = await seed(sql, '15')
      const res = await runGates(sql, {
        conversationId: b.conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: a.items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations.map((v) => v.gate)).toEqual(['provenance'])
      expect(res.violations[0]!.sourceIds).toEqual([a.items[0]!.sourceId])
    })
  })
})
