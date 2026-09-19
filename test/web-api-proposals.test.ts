// Plan 4a, Task 8. `makeDecide`/`makeRevise` return the `(user, req, ctx)`
// handler `withUser` wraps — this file calls those inner handlers directly
// with a fixed `SessionUser`, the same pattern test/web-api-messages.test.ts
// uses for `makePost`. Seeding a real, acceptable proposal follows
// test/cashier.test.ts's `seed` exactly (copied, not imported: that file's
// `seed` is not exported, and duplicating a small DB fixture here is cheaper
// than exporting test-only surface from a production module).
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeDecide, type DecideRouteDeps } from '../web/decideRoute.js'
import { makeRevise, type ReviseRouteDeps } from '../web/reviseRoute.js'
import type { SessionUser } from '../web/session.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { parseAction } from '../src/actions.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const flight: FlightSearch = { kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false }
const hotel: HotelSearch = { kind: 'hotel', query: 'Faro beach', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2, currency: 'EUR' }
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const approve = () => ({ content: [{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r', usage })
const withBudget = (nb: Notebook): Notebook => ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

const USER: SessionUser = { id: '00000000-0000-4000-8000-00000000d001', email: 'a@b.com' }
const OTHER: SessionUser = { id: '00000000-0000-4000-8000-00000000d002', email: 'c@d.com' }

async function seed(sql: postgres.Sql, userId: string, n: string) {
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'h' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const flights = new MockSupplier({ kind: 'flight', now: () => NOW })
  const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW })
  const fp = { ...flight, flexDays: Number(n) }, hp = { ...hotel, query: hotel.query + n }
  const fi = await flights.search(fp), hi = await hotels.search(hp)
  await recordResults(sql, { conversationId, userId, turnId, params: fp, items: fi })
  await recordResults(sql, { conversationId, userId, turnId, params: hp, items: hi })
  const path = { sql, transport: { create: vi.fn().mockResolvedValue(approve()) }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() }
  const ctx = { conversationId, userId, turnId }
  const outboundRef = { sourceId: fi[0]!.sourceId, quantity: 1, slot: 'outbound' }
  const stayRef = { sourceId: hi[0]!.sourceId, quantity: 1, slot: 'stay' }
  await runProposalPath(path, ctx, { micros: 0n }, { notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null,
    refs: [outboundRef, stayRef] })
  // The seeded turn stays 'running' unless finished explicitly (this seed
  // never calls whatever marks a turn 'done' in the real worker loop) — left
  // running, it would collide with `turns_one_active_per_conversation`
  // (0001_harness.sql) the moment `submitAction` tries to open a fresh turn
  // for the decide/revise call under test, and get refused as 'busy' (409)
  // for a reason that has nothing to do with what's under test here.
  await sql`update turns set status = 'done' where id = ${turnId}`
  const [p] = await sql`select id from proposals where conversation_id = ${conversationId}`
  return { ...ctx, proposalId: p!.id as string, fi, hi }
}

function req(body: unknown): Request {
  return new Request('http://x.test/api/proposals/x/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

describeDb('POST /api/proposals/[id]/decide', () => {
  it('accept records the decision, writes a hand_off action row, and queues a turn', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '01')
      const invoke = vi.fn().mockResolvedValue(undefined)
      const handler = makeDecide({ sql, invoke })

      const res = await handler(USER, req({ decision: 'accept' }), ctx(s.proposalId))

      expect(res.status).toBe(200)
      const body = (await res.json()) as { turnId: string }
      expect(body.turnId).toBeTruthy()
      expect(invoke).toHaveBeenCalledWith(body.turnId)

      const [proposal] = await sql`select decision from proposals where id = ${s.proposalId}`
      expect(proposal!.decision).toBe('accept')

      const msgs = await sql`select role, content from messages where conversation_id = ${s.conversationId} order by created_at`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('action')
      expect(parseAction(msgs[0]!.content as string)).toEqual({ action: 'hand_off', proposalId: s.proposalId })

      const turns = await sql`select status from turns where id = ${body.turnId}`
      expect(turns[0]!.status).toBe('queued')
    })
  })

  it('reject with a reason stores it via decideProposal AND as her own message, before the action row', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '02')
      const invoke = vi.fn().mockResolvedValue(undefined)
      const handler = makeDecide({ sql, invoke })

      const res = await handler(
        USER, req({ decision: 'reject', rejectReason: 'too far from the beach' }), ctx(s.proposalId),
      )

      expect(res.status).toBe(200)

      const [proposal] = await sql`select decision, reject_reason from proposals where id = ${s.proposalId}`
      expect(proposal!.decision).toBe('reject')
      expect(proposal!.reject_reason).toBe('too far from the beach')

      const msgs = await sql`select role, content, created_at from messages where conversation_id = ${s.conversationId} order by created_at`
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe('too far from the beach')
      expect(msgs[1]!.role).toBe('action')
      expect(parseAction(msgs[1]!.content as string)).toEqual({ action: 'rejected', proposalId: s.proposalId })
    })
  })

  it('a proposal belonging to another user is 404, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, OTHER.id, '03')
      const invoke = vi.fn()
      const handler = makeDecide({ sql, invoke })

      const res = await handler(USER, req({ decision: 'accept' }), ctx(s.proposalId))

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
      const [proposal] = await sql`select decision from proposals where id = ${s.proposalId}`
      expect(proposal!.decision).toBeNull()
      const msgs = await sql`select id from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('deciding twice returns 409 on the second call', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '04')
      const handler = makeDecide({ sql, invoke: vi.fn().mockResolvedValue(undefined) })

      const first = await handler(USER, req({ decision: 'accept' }), ctx(s.proposalId))
      expect(first.status).toBe(200)

      const second = await handler(USER, req({ decision: 'reject' }), ctx(s.proposalId))
      expect(second.status).toBe(409)

      const [proposal] = await sql`select decision from proposals where id = ${s.proposalId}`
      expect(proposal!.decision).toBe('accept')
    })
  })

  it('a non-uuid id is 404 before any query runs', async () => {
    await withTestDb(async (sql) => {
      const handler = makeDecide({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ decision: 'accept' }), ctx('not-a-uuid'))
      expect(res.status).toBe(404)
    })
  })

  it('an invalid decision value is 400', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '05')
      const handler = makeDecide({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ decision: 'maybe' }), ctx(s.proposalId))
      expect(res.status).toBe(400)
    })
  })

  it('a rejectReason sent alongside decision: accept is 400', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '05b')
      const handler = makeDecide({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ decision: 'accept', rejectReason: 'not applicable' }), ctx(s.proposalId))
      expect(res.status).toBe(400)
    })
  })

  // Fix round 1 (Task 8 review, Critical). Before this fix, `decideProposal`
  // ran BEFORE `submitAction` — a turn already in flight failed AFTER the
  // decision was already durable, leaving an accepted proposal with no
  // hand-off turn and no buttons (the card loses them once `decision` is
  // set). `decideProposal` now runs as `submitAction`'s `onFreshTurn` hook,
  // inside the SAME transaction as the turn insert, so it only ever runs
  // once a turn is actually won.
  it('a turn already in flight leaves the decision unrecorded (409, not silently accepted)', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '11')
      // A turn in flight for this conversation AT decide-time — the seed's
      // own turn is already marked 'done', so this simulates a traveller
      // pressing Accept while some other message/turn is still running.
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${s.conversationId}, ${USER.id}, 'in-flight', 'running')`
      const invoke = vi.fn()
      const handler = makeDecide({ sql, invoke })

      const res = await handler(USER, req({ decision: 'accept' }), ctx(s.proposalId))

      expect(res.status).toBe(409)
      expect(invoke).not.toHaveBeenCalled()
      const [proposal] = await sql`select decision from proposals where id = ${s.proposalId}`
      expect(proposal!.decision).toBeNull()
      const actionRows = await sql`select id from messages where conversation_id = ${s.conversationId} and role = 'action'`
      expect(actionRows).toHaveLength(0)
    })
  })

  it('the account spend ceiling leaves the decision unrecorded (429, not silently accepted)', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '12')
      // `on conflict … do update`, not a bare insert: `seed`'s own
      // `runProposalPath` call already spends (and upserts `daily_usage` for
      // this exact user+day) via the reviewer's model call, so a bare insert
      // here would hit the same `(user_id, day)` primary key seed itself just
      // created and fail outright rather than exercising the ceiling.
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER.id}, (now() at time zone 'utc')::date, ${DEFAULT_LIMITS.dailyCeilingMicros.toString()})
                on conflict (user_id, day) do update set cost_micros = excluded.cost_micros, updated_at = now()`
      const invoke = vi.fn()
      const handler = makeDecide({ sql, invoke })

      const res = await handler(USER, req({ decision: 'accept' }), ctx(s.proposalId))

      expect(res.status).toBe(429)
      expect(invoke).not.toHaveBeenCalled()
      const [proposal] = await sql`select decision from proposals where id = ${s.proposalId}`
      expect(proposal!.decision).toBeNull()
      const actionRows = await sql`select id from messages where conversation_id = ${s.conversationId} and role = 'action'`
      expect(actionRows).toHaveLength(0)
    })
  })
})

describeDb('POST /api/proposals/[id]/revise', () => {
  it('shift writes a revise action row naming the days, and queues a turn', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '06')
      const invoke = vi.fn().mockResolvedValue(undefined)
      const handler = makeRevise({ sql, invoke })

      const res = await handler(USER, req({ kind: 'shift', days: 2 }), ctx(s.proposalId))

      expect(res.status).toBe(200)
      const body = (await res.json()) as { turnId: string }
      expect(invoke).toHaveBeenCalledWith(body.turnId)

      const msgs = await sql`select role, content from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('action')
      expect(parseAction(msgs[0]!.content as string)).toEqual({
        action: 'revise', proposalId: s.proposalId, change: { kind: 'shift', days: 2 },
      })
    })
  })

  it('swap writes a revise action row naming the slot and sourceId', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '07')
      const handler = makeRevise({ sql, invoke: vi.fn().mockResolvedValue(undefined) })

      const res = await handler(
        USER, req({ kind: 'swap', slot: 'stay', sourceId: s.hi[0]!.sourceId }), ctx(s.proposalId),
      )

      expect(res.status).toBe(200)
      const msgs = await sql`select content from messages where conversation_id = ${s.conversationId}`
      expect(parseAction(msgs[0]!.content as string)).toEqual({
        action: 'revise', proposalId: s.proposalId,
        change: { kind: 'swap', slot: 'stay', sourceId: s.hi[0]!.sourceId },
      })
    })
  })

  it('a proposal belonging to another user is 404, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, OTHER.id, '08')
      const invoke = vi.fn()
      const handler = makeRevise({ sql, invoke })

      const res = await handler(USER, req({ kind: 'shift', days: -2 }), ctx(s.proposalId))

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
      const msgs = await sql`select id from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('an out-of-range shift (not ±2) is 400', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '09')
      const handler = makeRevise({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ kind: 'shift', days: 5 }), ctx(s.proposalId))
      expect(res.status).toBe(400)
    })
  })

  it('an unknown slot is 400', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '10')
      const handler = makeRevise({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ kind: 'swap', slot: 'bogus', sourceId: 'X' }), ctx(s.proposalId))
      expect(res.status).toBe(400)
    })
  })

  // Fix round 1 (Task 8 review, Important #3): a swap's sourceId is checked
  // against `tool_results` (owner connection, this conversation, the slot's
  // own kind) before submitAction ever runs.
  it('a swap sourceId from another conversation is 404, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '13')
      const other = await seed(sql, USER.id, '14')
      const handler = makeRevise({ sql, invoke: vi.fn() })

      const res = await handler(
        USER, req({ kind: 'swap', slot: 'stay', sourceId: other.hi[0]!.sourceId }), ctx(s.proposalId),
      )

      expect(res.status).toBe(404)
      const msgs = await sql`select id from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('a hotel sourceId sent for the outbound (flight) slot is 404', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '15')
      const handler = makeRevise({ sql, invoke: vi.fn() })

      const res = await handler(
        USER, req({ kind: 'swap', slot: 'outbound', sourceId: s.hi[0]!.sourceId }), ctx(s.proposalId),
      )

      expect(res.status).toBe(404)
      const msgs = await sql`select id from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })
})
