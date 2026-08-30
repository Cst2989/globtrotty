import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  DECISION_MAX_AGE_SECONDS, fitsBudget, handOffToBooking, totalOf,
} from '../src/cashier.js'
import type { ItemRef } from '../src/gates/types.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { compareMoney, CurrencyMismatchError, money, sumMoney, type Money } from '../src/money.js'
import { decideProposal, recordProposal } from '../src/repo/proposals.js'
import { recordResults } from '../src/repo/toolResults.js'
import { claimTurn, type Claim } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type {
  FlightSearch, HotelSearch, SearchParams, SupplierItem, SupplierPair,
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
    const proposalId = await recordProposal(sql, { conversationId, userId: USER, turnId, refs })
    if (over.decision !== null) {
      await decideProposal(sql, {
        proposalId, conversationId, decision: over.decision ?? 'accept',
        at: over.decidedAt ?? DECIDED_AT,
      })
    }
    return { conversationId, turnId, proposalId, items, suppliers }
  }

  const args = (over: Record<string, unknown>) => ({
    userId: USER, limits: DEFAULT_LIMITS, now: NOW, ...over,
  }) as Parameters<typeof handOffToBooking>[1]

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
      // One tenth of one percent. The tolerance is explicit and both sides of it
      // are pinned, because a boundary nobody tested is a boundary nobody chose.
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
      const proposalId = await recordProposal(sql, { conversationId, userId: USER, turnId, refs })
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
