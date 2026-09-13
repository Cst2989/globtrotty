import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  DECISION_MAX_AGE_SECONDS, fitsBudget, handOffToBooking, TOLERANCE_BPS, totalOf,
} from '../src/cashier.js'
import type { ItemRef } from '../src/gates/types.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { compareMoney, CurrencyMismatchError, money, sumMoney, type Money } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import { decideProposal, recordProposal } from '../src/repo/proposals.js'
import { recordResults } from '../src/repo/toolResults.js'
import { claimTurn, type Claim } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type {
  FlightSearch, HotelSearch, SearchParams, Supplier, SupplierItem, SupplierPair,
} from '../src/supplier/types.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()
const NOW = new Date('2026-08-16T12:00:00Z')
const QUOTED_AT = new Date('2026-08-16T10:00:00Z')
const DECIDED_AT = new Date('2026-08-16T11:50:00Z')

const flightSearch: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: '2026-09-25',
  flexDays: 0, adults: 2, children: 1, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const hotelSearch: HotelSearch = {
  kind: 'hotel', query: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25',
  adults: 2, currency: 'EUR',
}

describe('the cashier', () => {
  it('refuses to add a USD flight to a EUR hotel', async () => {
    // Built on purpose: a supplier configured to answer in a currency the
    // search did not ask for is exactly the fault lesson 4.5's currency gate
    // catches, and here it is the fault this function refuses to hide.
    const wrong = mockSuppliers({ flight: { currency: 'USD' } })
    const [flight] = await wrong.flight.search(flightSearch)
    const [hotel] = await wrong.hotel.search(hotelSearch)
    expect(flight!.price.currency).toBe('USD')
    expect(hotel!.price.currency).toBe('EUR')
    expect(() => totalOf([flight!, hotel!])).toThrow(CurrencyMismatchError)
  })

  it('totals a same-currency trip', async () => {
    const pair = mockSuppliers()
    const [flight] = await pair.flight.search(flightSearch)
    const [hotel] = await pair.hotel.search(hotelSearch)
    const total = totalOf([flight!, hotel!])
    expect(total.currency).toBe('EUR')
    expect(total.minor).toBe(flight!.price.minor + hotel!.price.minor)
  })

  it('refuses to tell her a dollar total fits a euro budget', () => {
    expect(() => fitsBudget(money(140000n, 'USD'), money(150000n, 'EUR')))
      .toThrow(CurrencyMismatchError)
  })

  it('answers the budget question when both sides are euros', () => {
    expect(fitsBudget(money(140000n, 'EUR'), money(150000n, 'EUR'))).toBe(true)
    expect(fitsBudget(money(160000n, 'EUR'), money(150000n, 'EUR'))).toBe(false)
  })

  it('refuses an empty list rather than inventing a currency for zero', () => {
    expect(() => totalOf([])).toThrow(/empty/i)
  })
})

/**
 * The re-quote as the articles describe it: ask again, compare the totals,
 * proceed if they match. Reproduced here rather than shipped, because this
 * lesson exists to say why it is not enough.
 */
async function naiveRequote(
  suppliers: SupplierPair, items: SupplierItem[], params: SearchParams,
): Promise<{ verified: boolean; total: Money }> {
  const fresh: Money[] = []
  for (const item of items) {
    const supplier = item.kind === 'flight' ? suppliers.flight : suppliers.hotel
    const q = await supplier.quote(item.sourceId, params)
    // "It came back, so it is fine." Two things are wrong with that and only
    // one of them is visible here.
    fresh.push(q.status === 'ok' ? q.item.price : item.price)
  }
  const before = sumMoney(items.map((i) => i.price))
  const after = sumMoney(fresh)
  return { verified: compareMoney(before, after) === 0, total: after }
}

describe('the re-quote before this lesson', () => {
  it('reports a stale cached price as verified, because it compared a cache with itself', async () => {
    // A supplier that cannot re-quote at all. It still ANSWERS: `quote` finds
    // the id it searched a moment ago and hands back the price it already had.
    const cached = mockSuppliers({ hotel: { mayRequote: false } })
    const items = await cached.hotel.search(hotelSearch)

    const { verified, total } = await naiveRequote(cached, items, hotelSearch)

    // Green, and worth nothing. The supplier said so itself, one field away.
    expect(verified).toBe(true)
    expect(cached.hotel.capabilities.mayRequote).toBe(false)
    expect(total.minor).toBe(sumMoney(items.map((i) => i.price)).minor)
  })

  it('reports a downgrade as verified, because it only compared the sum', async () => {
    // One item drops 5,000 minor units and another rises 5,000. The total is
    // identical and the trip is not: a refundable fare that became basic
    // economy is a downgrade she never accepted.
    const suppliers = mockSuppliers()
    const items = await suppliers.flight.search(flightSearch)
    const moved = [
      { ...items[0]!, price: money(items[0]!.price.minor - 5_000n, 'EUR') },
      { ...items[1]!, price: money(items[1]!.price.minor + 5_000n, 'EUR') },
    ]
    expect(sumMoney(moved.map((i) => i.price)).minor)
      .toBe(sumMoney([items[0]!, items[1]!].map((i) => i.price)).minor)
  })
})

describeDb('handOffToBooking', () => {
  /**
   * A conversation whose corpus can actually be written to. `recordResults`
   * takes a `Claim` and its write is fenced on a turn this claim still owns
   * (src/repo/toolResults.ts, lesson 4.3), so a bare `insert into
   * course.conversations` would record nothing at all. Same pair
   * `test/gate-pipeline.test.ts` uses: submit, then claim.
   */
  async function claimedTurn(sql: postgres.Sql): Promise<Claim> {
    const submitted = await submitMessage(handlerDeps(sql), {
      userId: USER, conversationId: null, message: 'a week in Faro', idempotencyKey: randomUUID(),
    })
    return (await claimTurn(sql, submitted.turnId!))!
  }

  /**
   * A conversation with a search in its corpus, a proposal she accepted, and a
   * turn to attribute the links to. Everything the cashier's precondition needs
   * and nothing it does not.
   */
  async function accepted(sql: postgres.Sql, n: number, over: {
    suppliers?: SupplierPair; decision?: 'accept' | 'reject' | null; decidedAt?: Date
  } = {}) {
    const claim = await claimedTurn(sql)
    const { conversationId, turnId } = claim
    const search: HotelSearch = { ...hotelSearch, query: `Faro-${n}` }
    const suppliers = over.suppliers ?? mockSuppliers({ hotel: { now: () => QUOTED_AT } })
    const items = await suppliers.hotel.search(search)
    await recordResults(sql, claim, { params: search, items })
    const refs: ItemRef[] = [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'stay' }]
    // The row is here for the cashier's precondition, so its snapshot is not
    // what these cases are about, and `recordProposal` refuses a missing one.
    const proposalId = await recordProposal(sql, {
      conversationId, userId: USER, turnId, refs, requirementsSnapshot: emptyNotebook(),
    })
    if (over.decision !== null) {
      await decideProposal(sql, {
        proposalId, conversationId, decision: over.decision ?? 'accept',
        at: over.decidedAt ?? DECIDED_AT,
      })
    }
    return { conversationId, turnId, proposalId, items, suppliers }
  }

  /**
   * The three fields every case shares, with the rest supplied per case. Typed
   * off `handOffToBooking`'s own parameter rather than cast to it: a
   * `Record<string, unknown>` plus an assertion would let a renamed field
   * compile here and refuse at runtime, which is the one thing a helper shared
   * by twenty cases must not do.
   */
  type HandOffArgs = Parameters<typeof handOffToBooking>[1]
  const args = (
    over: Omit<HandOffArgs, 'userId' | 'limits' | 'now'> & Partial<HandOffArgs>,
  ): HandOffArgs => ({ userId: USER, limits: DEFAULT_LIMITS, now: NOW, ...over })

  /**
   * The mock pair with the hotel's `quote` replaced, which is how the cases
   * below watch what the cashier asks a supplier and when. A spread of a class
   * instance copies its fields and not its prototype, so `search` does not
   * survive it and TypeScript refuses the direct assertion for insufficient
   * overlap; `as unknown as` is the same assertion the downgrade case makes,
   * and it is safe for the same reason: `handOffToBooking` reads only
   * `capabilities`, `quote` and `name` off a supplier.
   */
  function hotelQuoting(suppliers: SupplierPair, quote: Supplier['quote']): SupplierPair {
    return { ...suppliers, hotel: { ...suppliers.hotel, quote } as unknown as Supplier }
  }
  const realQuote = (suppliers: SupplierPair): Supplier['quote'] =>
    suppliers.hotel.quote.bind(suppliers.hotel)

  it('emits a link, on an allowlisted host, carrying its own tracking ref', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers, items } = await accepted(sql, 1)
      const res = await handOffToBooking(sql, args({ proposalId, conversationId, turnId, suppliers }))
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      expect(res.verified).toBe(true)
      expect(res.links).toHaveLength(1)
      const url = new URL(res.links[0]!.url)
      expect(url.hostname).toBe('example.invalid')
      expect(url.href).toContain(res.links[0]!.trackingRef)
      // The quoted price is the corpus price, not anything a caller supplied.
      expect(res.links[0]!.quoted.minor).toBe(items[0]!.price.minor)
    })
  })

  it('writes the link_clicks row BEFORE it returns the link', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers } = await accepted(sql, 2)
      const res = await handOffToBooking(sql, args({ proposalId, conversationId, turnId, suppliers }))
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      const rows = await sql`
        select id, url, tracking_ref, quoted_minor, currency, verified
          from course.link_clicks where turn_id = ${turnId} order by seq`
      expect(rows).toHaveLength(1)
      // The exact string she was given, not a template and not the pieces.
      expect(rows[0]!.url).toBe(res.links[0]!.url)
      expect(rows[0]!.tracking_ref).toBe(res.links[0]!.trackingRef)
      expect(rows[0]!.id).toBe(res.links[0]!.id)
      expect(BigInt(rows[0]!.quoted_minor as string)).toBe(res.links[0]!.quoted.minor)
      expect(rows[0]!.verified).toBe(true)
    })
  })

  it('refuses a proposal that does not exist', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, suppliers } = await accepted(sql, 3)
      const res = await handOffToBooking(sql, args({
        proposalId: randomUUID(), conversationId, turnId, suppliers,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('no_proposal')
    })
  })

  it('refuses a proposal from another conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await accepted(sql, 4)
      const b = await accepted(sql, 5)
      // A proposal id that exists, decided, accepted, and belonging to somebody
      // else's thread. Read by (id, conversation_id) is the whole defence.
      const res = await handOffToBooking(sql, args({
        proposalId: a.proposalId, conversationId: b.conversationId,
        turnId: b.turnId, suppliers: b.suppliers,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('no_proposal')
    })
  })

  it('refuses a proposal she has not accepted', async () => {
    await withTestDb(async (sql) => {
      const undecided = await accepted(sql, 6, { decision: null })
      const first = await handOffToBooking(sql, args({
        proposalId: undecided.proposalId, conversationId: undecided.conversationId,
        turnId: undecided.turnId, suppliers: undecided.suppliers,
      }))
      expect(first.ok).toBe(false)
      if (first.ok) throw new Error('unreachable')
      expect(first.refusal.kind).toBe('not_accepted')

      const rejected = await accepted(sql, 7, { decision: 'reject' })
      const second = await handOffToBooking(sql, args({
        proposalId: rejected.proposalId, conversationId: rejected.conversationId,
        turnId: rejected.turnId, suppliers: rejected.suppliers,
      }))
      expect(second.ok).toBe(false)
      if (second.ok) throw new Error('unreachable')
      expect(second.refusal.kind).toBe('not_accepted')
    })
  })

  it('refuses an acceptance older than thirty minutes', async () => {
    await withTestDb(async (sql) => {
      const stale = await accepted(sql, 8, {
        decidedAt: new Date(NOW.getTime() - (DECISION_MAX_AGE_SECONDS + 1) * 1000),
      })
      const res = await handOffToBooking(sql, args({
        proposalId: stale.proposalId, conversationId: stale.conversationId,
        turnId: stale.turnId, suppliers: stale.suppliers,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('stale_decision')

      // And the boundary on the other side: exactly thirty minutes still goes.
      const edge = await accepted(sql, 9, {
        decidedAt: new Date(NOW.getTime() - DECISION_MAX_AGE_SECONDS * 1000),
      })
      const ok = await handOffToBooking(sql, args({
        proposalId: edge.proposalId, conversationId: edge.conversationId,
        turnId: edge.turnId, suppliers: edge.suppliers,
      }))
      expect(ok.ok).toBe(true)
    })
  })

  /**
   * The lesson's own defect, closed. `naiveRequote` above calls this verified,
   * because a supplier with `mayRequote: false` still ANSWERS: it hands back
   * the price it already had, and comparing a cache with itself always agrees.
   */
  it('does not claim verification from a supplier that cannot re-quote', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers } = await accepted(sql, 10, {
        suppliers: mockSuppliers({ hotel: { mayRequote: false, now: () => QUOTED_AT } }),
      })
      const res = await handOffToBooking(sql, args({ proposalId, conversationId, turnId, suppliers }))
      // It still hands her a link. It just does not lie about it.
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      expect(res.verified).toBe(false)
      expect(res.message).not.toMatch(/checked|verified|confirmed/i)
      expect(res.message).toContain('hours ago')
      const [row] = await sql`select verified from course.link_clicks where turn_id = ${turnId}`
      expect(row!.verified).toBe(false)
    })
  })

  it('blocks on a price that moved past the tolerance, and names the item', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, items } = await accepted(sql, 11)
      // The corpus holds the searched price; the supplier now quotes more. The
      // drift is well past the half a percent tolerance.
      const drifted = mockSuppliers({
        hotel: { now: () => QUOTED_AT, quoteDriftMinor: items[0]!.price.minor / 4n },
      })
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers: drifted,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('moved')
      expect(res.refusal.sourceIds).toEqual([items[0]!.sourceId])
      // And nothing was emitted, which is the property that matters: a blocked
      // hand-off must leave no row behind, or the point-of-no-return check
      // would think a link went out.
      expect(await sql`select 1 from course.link_clicks where turn_id = ${turnId}`).toHaveLength(0)
    })
  })

  it('allows a move inside the half a percent tolerance', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, items } = await accepted(sql, 12)
      // One tenth of one percent, comfortably inside. The boundary itself is
      // pinned by the case below, on both sides and to the basis point, because
      // a boundary nobody tested is a boundary nobody chose.
      const drift = items[0]!.price.minor / 1000n
      const nudged = mockSuppliers({ hotel: { now: () => QUOTED_AT, quoteDriftMinor: drift } })
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers: nudged,
      }))
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      // She is quoted the NEW price, not the one the corpus held: a re-quote
      // that verified a number and then emitted a different one would be worse
      // than no re-quote.
      expect(res.links[0]!.quoted.minor).toBe(items[0]!.price.minor + drift)
    })
  })

  it('blocks when the re-quote could not be made at all, because unknown is not unchanged', async () => {
    await withTestDb(async (sql) => {
      for (const [n, mode] of [[13, 'unavailable'], [14, 'throw'], [15, 'gone']] as const) {
        const { conversationId, turnId, proposalId } = await accepted(sql, n)
        const broken = mockSuppliers({ hotel: { now: () => QUOTED_AT, quoteMode: mode } })
        const res = await handOffToBooking(sql, args({
          proposalId, conversationId, turnId, suppliers: broken,
        }))
        expect(res.ok, mode).toBe(false)
        if (res.ok) throw new Error('unreachable')
        expect(res.refusal.kind, mode).toBe('unverifiable')
        expect(await sql`select 1 from course.link_clicks where turn_id = ${turnId}`).toHaveLength(0)
      }
    })
  })

  it('blocks when the re-quote came back in another currency', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, items } = await accepted(sql, 16)
      // Same id, same price, different currency. The sum would be meaningless
      // and comparing them would throw, so it is an identity change and blocks.
      const relabelled = mockSuppliers({ hotel: { now: () => QUOTED_AT, currency: 'USD' } })
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers: relabelled,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('moved')
      expect(res.refusal.detail).toContain(items[0]!.sourceId)
    })
  })

  it('blocks on a downgrade the total hides', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      const { conversationId, turnId } = claim
      const search: FlightSearch = { ...flightSearch, from: 'BER', to: 'OPO' }
      const suppliers = mockSuppliers({ flight: { now: () => QUOTED_AT } })
      const items = await suppliers.flight.search(search)
      await recordResults(sql, claim, { params: search, items })
      const refs: ItemRef[] = [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }]
      // Here for the cashier's precondition, so the snapshot is not what this
      // case is about, and `recordProposal` refuses a missing one.
      const proposalId = await recordProposal(sql, {
        conversationId, userId: USER, turnId, refs, requirementsSnapshot: emptyNotebook(),
      })
      await decideProposal(sql, { proposalId, conversationId, decision: 'accept', at: DECIDED_AT })

      // A supplier that returns the same id at the same price with a different
      // itinerary: one segment instead of two. The sum is identical, so a
      // total-only comparison passes, and the fare she accepted is gone.
      const downgraded: SupplierPair = {
        ...suppliers,
        flight: {
          ...suppliers.flight,
          quote: async (sourceId: string) => {
            const found = items.find((i) => i.sourceId === sourceId)!
            if (found.detail.kind !== 'flight') throw new Error('unreachable')
            return {
              status: 'ok',
              item: { ...found, detail: { ...found.detail, outbound: {
                ...found.detail.outbound, flightNumbers: ['XX999'],
              } } },
            }
          },
        } as unknown as typeof suppliers.flight,
      }
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers: downgraded,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('moved')
      expect(res.refusal.detail).toMatch(/itinerary|flight number/i)
    })
  })

  it('refuses at the global ceiling, the one built in lesson 2.6', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers } = await accepted(sql, 17)
      // Everyone's spend today, not hers: the global ceiling is the only one
      // that can fire while both per-user counters read zero, and it is the one
      // standing between the model and a booking link.
      await sql`insert into course.daily_usage (user_id, day, cost_micros)
                values (${randomUUID()}, (now() at time zone 'utc')::date,
                        ${DEFAULT_LIMITS.globalCeilingMicros.toString()})`
      const res = await handOffToBooking(sql, args({ proposalId, conversationId, turnId, suppliers }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('limit_reached')
      expect(res.refusal.detail).toContain('account')
      expect(await sql`select 1 from course.link_clicks where turn_id = ${turnId}`).toHaveLength(0)
    })
  })

  /**
   * The tolerance itself, from both sides, in the same integer arithmetic
   * `withinTolerance` uses. `drift * 10_000 <= before.minor * TOLERANCE_BPS` is
   * a `<=`, so exactly half a percent is inside it and one minor unit more is
   * not, whatever `price * 50 / 10_000` rounds to. Without these two, tightening
   * that `<=` to a `<` while tidying leaves the suite green and starts blocking
   * every supplier that rounds to exactly the tolerance.
   */
  it('takes a move of exactly the tolerance, and refuses one minor unit past it', async () => {
    await withTestDb(async (sql) => {
      const at = await accepted(sql, 19)
      const exact = at.items[0]!.price.minor * TOLERANCE_BPS / 10_000n
      const onTheLine = mockSuppliers({ hotel: { now: () => QUOTED_AT, quoteDriftMinor: exact } })
      const ok = await handOffToBooking(sql, args({
        proposalId: at.proposalId, conversationId: at.conversationId,
        turnId: at.turnId, suppliers: onTheLine,
      }))
      expect(ok.ok).toBe(true)
      if (!ok.ok) throw new Error('unreachable')
      expect(ok.links[0]!.quoted.minor).toBe(at.items[0]!.price.minor + exact)

      const over = await accepted(sql, 20)
      // Recomputed from THIS proposal's price: the two conversations search
      // different queries, so they hold different numbers, and a tolerance
      // taken from the other one is not a boundary at all.
      const justPast = over.items[0]!.price.minor * TOLERANCE_BPS / 10_000n + 1n
      const past = mockSuppliers({ hotel: { now: () => QUOTED_AT, quoteDriftMinor: justPast } })
      const blocked = await handOffToBooking(sql, args({
        proposalId: over.proposalId, conversationId: over.conversationId,
        turnId: over.turnId, suppliers: past,
      }))
      expect(blocked.ok).toBe(false)
      if (blocked.ok) throw new Error('unreachable')
      expect(blocked.refusal.kind).toBe('moved')
      expect(await sql`select 1 from course.link_clicks where turn_id = ${over.turnId}`).toHaveLength(0)
    })
  })

  /**
   * The model has the links and calls the tool again in the same turn, with a
   * different `callId`, so `ledgerRunner` does not replay it. Before this
   * refusal the cashier re-quoted the whole set a second time (rule 6 says
   * nothing may re-quote a set that has been emitted) and then hit
   * `unique (proposal_id, item_id)` as an unhandled Postgres error, which in
   * `scripts/trip.ts` and `scripts/demo.ts` is a dead script.
   */
  it('refuses a second hand-off of the same proposal, before it re-quotes anything', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers } = await accepted(sql, 21)
      const asked: string[] = []
      const counting = hotelQuoting(suppliers, async (id, params, signal) => {
        asked.push(id)
        return realQuote(suppliers)(id, params, signal)
      })
      const a = args({ proposalId, conversationId, turnId, suppliers: counting })
      const first = await handOffToBooking(sql, a)
      expect(first.ok).toBe(true)
      expect(asked).toHaveLength(1)

      const second = await handOffToBooking(sql, a)
      expect(second.ok).toBe(false)
      if (second.ok) throw new Error('unreachable')
      expect(second.refusal.kind).toBe('already_emitted')
      // The point: no second re-quote, so the refusal is decided before
      // anything is asked of a supplier, and no second row.
      expect(asked).toHaveLength(1)
      expect(await sql`select 1 from course.link_clicks where turn_id = ${turnId}`).toHaveLength(1)
    })
  })

  /**
   * The signal lesson 4.2 threaded through every supplier call, now reaching
   * the one call that is not a search. `withHeartbeat` (src/worker.ts) aborts
   * the instant a tick discovers this worker has been superseded, and a
   * re-quote that runs to completion afterwards writes `course.link_clicks`
   * rows stamped with a turn the NEW worker owns.
   */
  it('hands its caller\'s own abort signal to every re-quote', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers } = await accepted(sql, 22)
      const seen: (AbortSignal | undefined)[] = []
      const watching = hotelQuoting(suppliers, async (id, params, signal) => {
        seen.push(signal)
        return realQuote(suppliers)(id, params, signal)
      })
      const controller = new AbortController()
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers: watching, signal: controller.signal,
      }))
      expect(res.ok).toBe(true)
      // Identity, not "some signal": the whole point is that the fenced
      // worker's own signal is the one that reaches the supplier.
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBe(controller.signal)
    })
  })

  it('emits nothing when the fence lands mid re-quote', async () => {
    await withTestDb(async (sql) => {
      // The re-quote comes back fine and the worker no longer owns the turn.
      // Emitting now would hand a dead turn's model two live booking URLs and
      // leave the rows under the new worker's turn id.
      const won = await accepted(sql, 23)
      const superseded = new AbortController()
      const fenced = hotelQuoting(won.suppliers, async (id, params, signal) => {
        superseded.abort(new Error('superseded by another worker'))
        return realQuote(won.suppliers)(id, params, signal)
      })
      await expect(handOffToBooking(sql, args({
        proposalId: won.proposalId, conversationId: won.conversationId,
        turnId: won.turnId, suppliers: fenced, signal: superseded.signal,
      }))).rejects.toThrow(/superseded by another worker/)
      expect(await sql`select 1 from course.link_clicks where turn_id = ${won.turnId}`).toHaveLength(0)

      // And an aborted call that throws leaves as the abort's own reason
      // rather than as `unverifiable`: a cancelled request is not a supplier
      // that could not confirm a price, and the model is not going to get
      // another step in which to work around it (src/tools.ts says the same).
      const lost = await accepted(sql, 24)
      const cancelled = new AbortController()
      const dies = hotelQuoting(lost.suppliers, async () => {
        cancelled.abort(new Error('superseded mid flight'))
        throw new Error('The operation was aborted')
      })
      await expect(handOffToBooking(sql, args({
        proposalId: lost.proposalId, conversationId: lost.conversationId,
        turnId: lost.turnId, suppliers: dies, signal: cancelled.signal,
      }))).rejects.toThrow(/superseded mid flight/)
      expect(await sql`select 1 from course.link_clicks where turn_id = ${lost.turnId}`).toHaveLength(0)
    })
  })

  it('refuses a proposal recorded for another user', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers } = await accepted(sql, 25)
      // Every caller derives both ids from one claim, so they agree today. If
      // they ever stop agreeing, the ceiling below is read for one user and the
      // link_clicks row is written for the other, and that row survives the
      // cleanups in test/helpers/db.ts and scripts/demo.ts, which delete by
      // user_id.
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers, userId: randomUUID(),
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('no_proposal')
    })
  })

  it('refuses a proposal carrying no items rather than throwing on the total', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      // `ProposalRefsSchema` has `.min(1)`, so `proposalRunner` cannot write
      // this one; `loadProposal` returns `refs` straight out of jsonb with no
      // validation, and lesson 5.7 will be a second writer of this table. A
      // refusal is cheaper than "Reduce of empty array".
      const proposalId = await recordProposal(sql, {
        conversationId: claim.conversationId, userId: USER, turnId: claim.turnId, refs: [],
        // Here for the cashier's precondition, so the snapshot is not what
        // this case is about, and `recordProposal` refuses a missing one.
        requirementsSnapshot: emptyNotebook(),
      })
      await decideProposal(sql, {
        proposalId, conversationId: claim.conversationId, decision: 'accept', at: DECIDED_AT,
      })
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId: claim.conversationId, turnId: claim.turnId,
        suppliers: mockSuppliers(),
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('no_proposal')
      expect(res.refusal.detail).toMatch(/no items/i)
    })
  })

  it('refuses a re-quote that came back as a different item, and links to neither', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers, items } = await accepted(sql, 26)
      // A substitute: same price, same currency, same kind, different id. Both
      // live adapters find by native id so nothing can produce one today, and
      // an adapter that offers "the nearest available room" would put her on a
      // link to an item the gates never approved, stored under an item_id the
      // unique constraint then fails to protect.
      const substitute = hotelQuoting(suppliers, async (id, params, signal) => {
        const real = await realQuote(suppliers)(id, params, signal)
        if (real.status !== 'ok') throw new Error('unreachable')
        return { status: 'ok', item: { ...real.item, sourceId: `${id}-substitute` } }
      })
      const res = await handOffToBooking(sql, args({
        proposalId, conversationId, turnId, suppliers: substitute,
      }))
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.refusal.kind).toBe('moved')
      expect(res.refusal.sourceIds).toEqual([items[0]!.sourceId])
      expect(await sql`select 1 from course.link_clicks where turn_id = ${turnId}`).toHaveLength(0)
    })
  })

  it('never emits a supplier-supplied URL, even though the corpus holds one', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId, proposalId, suppliers, items } = await accepted(sql, 18)
      expect(items[0]!.bookingUrl).toContain('https://example.invalid/hotel-')
      const res = await handOffToBooking(sql, args({ proposalId, conversationId, turnId, suppliers }))
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      // Same host, because the mock's template points there, and a different
      // URL: it carries our tracking ref and it was built here.
      expect(res.links[0]!.url).not.toBe(items[0]!.bookingUrl)
      expect(res.links[0]!.url).toContain('/book/')
      expect(res.links[0]!.url).toContain(res.links[0]!.trackingRef)
    })
  })
})
