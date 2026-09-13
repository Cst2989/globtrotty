# Plan 3b — Gates Half Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `propose_itinerary` save a reviewed proposal row, and add the three tools that act on one: `revise_component`, `hand_off_to_booking` (the cashier), and `escalate_to_human`.

**Architecture:** One shared proposal path (`gates → reviewer → saveProposal`) serves both `propose_itinerary` and `revise_component`. The reviewer is a second seat that reuses the driver's reserve/reconcile/record trio. The cashier re-quotes through the supplier port and mints `link_clicks`. Escalation is a row plus a `Notifier` port. Every tool is a code door in `src/agents/driver.ts`'s `execute` switch, with the logic in its own module.

**Tech Stack:** TypeScript (NodeNext ESM, no build step), postgres.js, zod 4, `@anthropic-ai/sdk` 0.122 (transport-injected), vitest. DB tests run in a rolled-back transaction via `test/helpers/db.ts` and skip without `DATABASE_URL`.

**Spec:** `docs/superpowers/specs/2026-09-13-plan-3b-gates-design.md` (this plan), narrowing `docs/superpowers/specs/2026-08-15-globetrotty-design.md` §3–§5, §7 (binding).

## Global Constraints

- Money is `bigint` minor units in TypeScript and `bigint` columns in Postgres. No floats touch a price. `Money` values come from `money()` in `src/money.ts`.
- The model never supplies a price, URL, or provenance; every such value is rehydrated from `tool_results` or built server-side.
- Exactly three functions move money: `recordSpend`, `reserve`, `reconcile`. This plan adds callers, never a fourth door.
- One `gate_results` row per `(turn_id, round, gate)`; `round` must advance for every gate run in a turn (migration 0013).
- Every model call goes through `callModel` in `src/model/client.ts` with `reserve` before and `reconcile` after, and writes a `model_calls` row via `recordModelCall`.
- Any tool result containing untrusted text passes through `sanitizeSourceId` (ids) or `fenceResult` (bodies) before reaching the model.
- Tests that guard a rule must be shown to fail when the rule is broken (break, watch fail, restore). The plan names the break per test.
- Commit after every task. Commit messages end with the attribution lines the session provides.
- Run `pnpm test`, `pnpm typecheck`, `pnpm lint` before every commit. All three must be clean.
- Never edit `supabase/migrations/0001`–`0013`. New DDL is `0014_plan_3b_gates.sql`.
- Prompt version strings: `driver@2`, `reviewer@1`.
- No new required environment variable (`src/env.ts` `KEYS` unchanged).

## Deviations from the spec, decided while planning

1. **Cashier atomicity.** The spec said "mint `link_clicks` rows and finish the `tool_calls` row in one transaction". `finishToolCall` belongs to the worker, not the tool. The plan instead mints all links in one transaction inside the tool, and relies on the worker's existing `pending` row: a resumed turn finds it and reports `ambiguous`, which fails the turn as `fenced` rather than re-quoting. The links already committed are readable by `proposal_id`. Task 8 records this in the code comment.
2. **Hotel URL allowlist.** SearchApi's `link` is each property's own site (`test/fixtures/searchapi-hotels.json` carries booking.com, bluepillow.com and hotel-owned domains), so there is no fixed hostname to allow. The check for SearchApi is: `https:` scheme, no userinfo, hostname is a registrable domain (has a dot, not an IP, not `localhost`). Kiwi keeps a real allowlist (`kiwi.com` and subdomains). Task 7.
3. **Reviewer at the spending ceiling.** If `reserve` for the reviewer reports a ceiling reached, the reservation is refunded, the review is skipped, and the proposal is saved `shipped_unapproved` with the issue `reviewer skipped: spending limit reached`. The next driver step then fails the turn on the same ceiling with her message. A throw from inside `run()` would fail the turn as `unclassified`, which is the wrong word. Task 4.
4. **Reviewer spend reaches `turns.spend_usd_micros`.** The reviewer runs inside `run()`, after the worker has read `recordedMicros`. The `tool` step gains an optional `spent: { micros: bigint }` accumulator the tool increments; the worker adds it to the turn total after `run()` resolves. Task 5.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0014_plan_3b_gates.sql` | `proposals.parent_proposal_id`, `escalations` table |
| `src/repo/proposals.ts` | `saveProposal`, `loadProposal`, `decideProposal`, itinerary (de)serialisation |
| `src/repo/gateResults.ts` | + `countReviewerVerdicts`, `attachProposal` |
| `src/repo/toolCalls.ts` | `countPriorProposals` → `countPriorGateRuns` (both tool names) |
| `src/repo/escalations.ts` | `recordEscalation`, `countEscalationsToday` |
| `src/model/client.ts` | `CallArgs.outputSchema` → `output_config.format` |
| `src/agents/reviewer.ts` + `prompts/reviewer.md` | The reviewer seat |
| `src/agents/proposalPath.ts` | gates → reviewer → save, shared by propose and revise |
| `src/tools/revise.ts` | Rebuild refs from a parent proposal |
| `src/tools/cashier.ts` | The hand-off |
| `src/tools/escalate.ts` | Escalation tool logic |
| `src/notify.ts` | `Notifier` port + `LogNotifier` |
| `src/supplier/types.ts`, `mock.ts`, `kiwi.ts`, `searchapi.ts` | `bookingUrl` on the port |
| `src/tools/registry.ts` | Three new tool schemas, `DESK_TOOLS.planning` |
| `src/agents/driver.ts`, `prompts/driver.md` | Handlers, `DriverDeps.notifier`, `driver@2` |
| `src/worker.ts`, `src/engine.ts` | `spent` accumulator; `TurnState.reviewRounds` removed |
| `test/*.test.ts` | One file per module, named below |

---

### Task 1: Migration 0014 and its schema test

**Files:**
- Create: `supabase/migrations/0014_plan_3b_gates.sql`
- Create: `test/schema-3b.test.ts`

**Interfaces:**
- Produces: `proposals.parent_proposal_id uuid null`, table `escalations`.

- [ ] **Step 1: Write the failing schema test**

```ts
// test/schema-3b.test.ts
import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

const USER = '00000000-0000-4000-8000-00000000a001'

async function seedProposal(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning id`
  const [p] = await sql`
    insert into proposals (conversation_id, user_id, itinerary, requirements_snapshot,
                           total_minor, currency, gate_outcome)
    values (${c.id}, ${USER}, ${sql.json({ items: [] })}, ${sql.json({})}, 0, 'EUR', 'approved')
    returning id`
  return { conversationId: c.id as string, proposalId: p.id as string }
}

describeDb('0014 plan 3b schema', () => {
  it('lets a proposal name its parent, and nulls the link when the parent goes', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, proposalId } = await seedProposal(sql)
      const [child] = await sql`
        insert into proposals (conversation_id, user_id, itinerary, requirements_snapshot,
                               total_minor, currency, gate_outcome, parent_proposal_id)
        values (${conversationId}, ${USER}, ${sql.json({ items: [] })}, ${sql.json({})},
                0, 'EUR', 'approved', ${proposalId})
        returning id, parent_proposal_id`
      expect(child!.parent_proposal_id).toBe(proposalId)
      await sql`delete from proposals where id = ${proposalId}`
      const [after] = await sql`select parent_proposal_id from proposals where id = ${child!.id}`
      expect(after!.parent_proposal_id).toBeNull()
    })
  })

  it('records an escalation with a fixed reason and refuses free text', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, proposalId } = await seedProposal(sql)
      const [e] = await sql`
        insert into escalations (conversation_id, user_id, proposal_id, reason)
        values (${conversationId}, ${USER}, ${proposalId}, 'price_moved')
        returning id, notified_at`
      expect(e!.id).toBeTruthy()
      expect(e!.notified_at).toBeNull()
      await expect(sql`
        insert into escalations (conversation_id, user_id, reason)
        values (${conversationId}, ${USER}, 'the hotel smelled')`)
        .rejects.toThrow(/check constraint/i)
    })
  })

  it('refuses an escalation whose conversation belongs to another user', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seedProposal(sql)
      await expect(sql`
        insert into escalations (conversation_id, user_id, reason)
        values (${conversationId}, '00000000-0000-4000-8000-00000000a002', 'safety')`)
        .rejects.toThrow(/foreign key/i)
    })
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm vitest run test/schema-3b.test.ts`
Expected: FAIL, `column "parent_proposal_id" of relation "proposals" does not exist` and `relation "escalations" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0014_plan_3b_gates.sql
--
-- Plan 3b. Two additions, both spec-driven.
--
-- 1. proposals.parent_proposal_id. Spec 3b ruling: a revision is a NEW proposal
--    row, never a mutation of the one she saw, so the accepted snapshot and the
--    shipped itinerary cannot diverge. `on delete set null`: losing the parent
--    must not cascade-delete a child she may already have accepted.
--
-- 2. escalations. Spec section 4: "fixed-format (ids + enum reason codes, no
--    model free text), rate-limited per user per day". The check constraint IS
--    the "no free text" rule; the (user_id, created_at) index serves the daily
--    count. notified_at stays null until a Notifier confirms delivery, so a
--    recorded-but-unsent escalation is distinguishable from a sent one.

alter table proposals
  add column parent_proposal_id uuid references proposals(id) on delete set null;
create index proposals_by_parent on proposals (parent_proposal_id)
  where parent_proposal_id is not null;

create table escalations (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete set null,
  proposal_id     uuid references proposals(id) on delete set null,
  reason          text not null check (reason in
                    ('supplier_unavailable','price_moved','user_request','safety','cannot_satisfy')),
  created_at      timestamptz not null default now(),
  notified_at     timestamptz,
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade
);
create index escalations_by_user_day on escalations (user_id, created_at desc);
create index escalations_by_conversation on escalations (conversation_id);

revoke all on escalations from anon, authenticated;
alter table escalations enable row level security;
```

- [ ] **Step 4: Apply it to the test database and re-run**

Run: `psql "$DATABASE_URL" -f supabase/migrations/0014_plan_3b_gates.sql` (or the project's usual apply path from `supabase/README` if one exists; check `git log -1 --format=%B -- supabase/migrations/0013_gate_results_round_unique.sql` for how 0013 was applied), then `pnpm vitest run test/schema-3b.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0014_plan_3b_gates.sql test/schema-3b.test.ts
git commit -m "feat(schema): migration 0014 — proposal lineage and escalations table"
```

---

### Task 2: The proposals repository

**Files:**
- Create: `src/repo/proposals.ts`
- Modify: `src/repo/gateResults.ts` (add `attachProposal`, `countReviewerVerdicts`)
- Create: `test/proposals-repo.test.ts`

**Interfaces:**
- Consumes: `RehydratedItem` (`src/gates/types.ts`), `Money`, `Notebook`.
- Produces:

```ts
export type StoredItineraryItem = {
  slot: string; quantity: number
  sourceId: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  priceMinor: string; currency: string; priceBasis: 'total' | 'pre_tax'
  fetchedAt: string                      // ISO
  lineTotalMinor: string
  detail: FlightDetail | HotelDetail
  searchParams: SearchParams | null
}
export type StoredItinerary = { schemaVersion: 1; items: StoredItineraryItem[] }
export type GateOutcomeLabel = 'approved' | 'shipped_unapproved'
export type ProposalRow = {
  id: string; conversationId: string; userId: string; turnId: string | null
  itinerary: StoredItinerary; totalMinor: bigint; currency: string
  gateOutcome: GateOutcomeLabel; reviewRounds: number; reviewIssues: string[]
  decision: 'accept' | 'reject' | null; decidedAt: Date | null
  parentProposalId: string | null; createdAt: Date
}
export function toStoredItinerary(items: RehydratedItem[]): StoredItinerary
export async function saveProposal(sql, args: {
  conversationId: string; userId: string; turnId: string | null; round: number
  items: RehydratedItem[]; total: Money; notebook: Notebook
  gateOutcome: GateOutcomeLabel; reviewRounds: number; reviewIssues: string[]
  promptVersion: string; modelConfigId: string; parentProposalId: string | null
}): Promise<string>                       // the new proposal id
export async function loadProposal(sql, conversationId: string, proposalId: string): Promise<ProposalRow | null>
export async function decideProposal(sql, args: {
  proposalId: string; conversationId: string
  decision: 'accept' | 'reject'; rejectReason?: string | null; now?: Date
}): Promise<void>
// gateResults.ts
export async function attachProposal(sql, args: { turnId: string; round: number; proposalId: string }): Promise<void>
export async function countReviewerVerdicts(sql, turnId: string): Promise<number>
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/proposals-repo.test.ts
import { expect, it } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults } from '../src/repo/toolResults.js'
import { runGates } from '../src/gates/pipeline.js'
import { recordGateResults, attachProposal, countReviewerVerdicts } from '../src/repo/gateResults.js'
import { saveProposal, loadProposal, decideProposal, toStoredItinerary } from '../src/repo/proposals.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-09-13T12:00:00Z')

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-0000000009${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                        values (${c!.id}, ${userId}, ${'p' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const items = await new MockSupplier({ kind: 'flight', now: () => NOW })
    .search({ ...params, flexDays: Number(n) })
  await recordResults(sql, { conversationId, userId, turnId, params: { ...params, flexDays: Number(n) }, items })
  const outcome = await runGates(sql, {
    conversationId, turnId, round: 0, now: NOW,
    refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' }],
    notebook: { budget: money(10_000_00n, 'EUR'), window: null, currency: 'EUR' },
  })
  if (!outcome.ok) throw new Error('seed: gates rejected')
  return { userId, conversationId, turnId, outcome }
}

describeDb('proposals repo', () => {
  it('saves the REHYDRATED itinerary and attaches the round\'s gate rows', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      const row = await loadProposal(sql, s.conversationId, id)
      expect(row).not.toBeNull()
      expect(row!.itinerary.schemaVersion).toBe(1)
      expect(row!.itinerary.items[0]!.priceMinor).toBe(s.outcome.items[0]!.item.price.minor.toString())
      expect(row!.totalMinor).toBe(s.outcome.total.minor)
      expect(row!.gateOutcome).toBe('approved')
      const attached = await sql<{ n: number }[]>`
        select count(*)::int as n from gate_results
         where turn_id = ${s.turnId} and round = 0 and proposal_id = ${id}`
      expect(attached[0]!.n).toBe(7)
    })
  })

  it('does not attach gate rows from a DIFFERENT round', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      await recordGateResults(sql, { conversationId: s.conversationId, turnId: s.turnId,
        proposalId: null, round: 1, results: [{ gate: 'provenance', passed: true, detail: null, sourceIds: [] }] })
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      const [r1] = await sql`select proposal_id from gate_results where turn_id = ${s.turnId} and round = 1`
      expect(r1!.proposal_id).toBeNull()
      const attached = await sql<{ n: number }[]>`
        select count(*)::int as n from gate_results where proposal_id = ${id}`
      expect(attached[0]!.n).toBe(7)
    })
  })

  it('loads nothing for a proposal from another conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '03'); const b = await seed(sql, '04')
      const id = await saveProposal(sql, {
        conversationId: a.conversationId, userId: a.userId, turnId: a.turnId, round: 0,
        items: a.outcome.items, total: a.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      expect(await loadProposal(sql, b.conversationId, id)).toBeNull()
    })
  })

  it('records an accept with the accepted total copied, once, in this conversation only', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      await expect(decideProposal(sql, { proposalId: id, conversationId: '00000000-0000-4000-8000-000000000000', decision: 'accept' }))
        .rejects.toThrow(/not found/i)
      await decideProposal(sql, { proposalId: id, conversationId: s.conversationId, decision: 'accept', now: NOW })
      const [row] = await sql`select decision, decided_at, accepted_total_minor, accepted_currency from proposals where id = ${id}`
      expect(row!.decision).toBe('accept')
      expect(BigInt(row!.accepted_total_minor as string)).toBe(s.outcome.total.minor)
      expect(row!.accepted_currency).toBe('EUR')
      expect(new Date(row!.decided_at as Date).toISOString()).toBe(NOW.toISOString())
      await expect(decideProposal(sql, { proposalId: id, conversationId: s.conversationId, decision: 'reject' }))
        .rejects.toThrow(/already decided/i)
    })
  })

  it('counts reviewer verdicts on THIS turn only', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '06'); const b = await seed(sql, '07')
      await recordGateResults(sql, { conversationId: a.conversationId, turnId: a.turnId, proposalId: null, round: 0,
        results: [{ gate: 'reviewer', passed: false, detail: 'no', sourceIds: [] }] })
      await recordGateResults(sql, { conversationId: b.conversationId, turnId: b.turnId, proposalId: null, round: 0,
        results: [{ gate: 'reviewer', passed: true, detail: null, sourceIds: [] }] })
      expect(await countReviewerVerdicts(sql, a.turnId)).toBe(1)
      expect(await countReviewerVerdicts(sql, b.turnId)).toBe(1)
    })
  })

  it('serialises money and dates as strings, so the row survives JSON', () => {
    const it0 = {
      ref: { sourceId: 'X', quantity: 1, slot: 'outbound' },
      item: { sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'n',
        price: money(123n, 'EUR'), priceBasis: 'total' as const, fetchedAt: NOW, ttlSeconds: 900,
        bookingUrl: null, detail: { kind: 'flight' as const, outbound: { from: 'A', to: 'B', departureLocal: 'x', arrivalLocal: 'y', stops: 0, route: [], cabinClass: 'E', carriers: [], flightNumbers: ['ZZ1'] }, inbound: null, baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 1, selfTransfer: false },
        searchParams: null },
      lineTotal: money(123n, 'EUR'),
    }
    const out = toStoredItinerary([it0])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    expect(out.items[0]!.priceMinor).toBe('123')
    expect(out.items[0]!.fetchedAt).toBe(NOW.toISOString())
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run test/proposals-repo.test.ts`
Expected: FAIL, cannot resolve `../src/repo/proposals.js`.

- [ ] **Step 3: Implement**

```ts
// src/repo/proposals.ts
import type postgres from 'postgres'
import type { RehydratedItem } from '../gates/types.js'
import type { Money } from '../money.js'
import type { Notebook } from '../notebook.js'
import type { FlightDetail, HotelDetail, SearchParams } from '../supplier/types.js'
import { attachProposal } from './gateResults.js'

export type StoredItineraryItem = {
  slot: string; quantity: number
  sourceId: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  priceMinor: string; currency: string; priceBasis: 'total' | 'pre_tax'
  fetchedAt: string
  lineTotalMinor: string
  detail: FlightDetail | HotelDetail
  searchParams: SearchParams | null
}
export type StoredItinerary = { schemaVersion: 1; items: StoredItineraryItem[] }
export type GateOutcomeLabel = 'approved' | 'shipped_unapproved'

export type ProposalRow = {
  id: string; conversationId: string; userId: string; turnId: string | null
  itinerary: StoredItinerary; totalMinor: bigint; currency: string
  gateOutcome: GateOutcomeLabel; reviewRounds: number; reviewIssues: string[]
  decision: 'accept' | 'reject' | null; decidedAt: Date | null
  parentProposalId: string | null; createdAt: Date
}

/**
 * The itinerary column holds what the GATES returned, never what the model
 * sent. Money and dates are strings: `bigint` and `Date` do not survive
 * `JSON.stringify`, and `sql.json` would throw on the former. Version 1;
 * `itinerary_schema_version` on the row carries the same number so a reader
 * can refuse a shape it does not know.
 */
export function toStoredItinerary(items: RehydratedItem[]): StoredItinerary {
  return {
    schemaVersion: 1,
    items: items.map(({ ref, item, lineTotal }) => ({
      slot: ref.slot, quantity: ref.quantity,
      sourceId: item.sourceId, supplier: item.supplier, kind: item.kind, name: item.name,
      priceMinor: item.price.minor.toString(), currency: item.price.currency,
      priceBasis: item.priceBasis, fetchedAt: item.fetchedAt.toISOString(),
      lineTotalMinor: lineTotal.minor.toString(),
      detail: item.detail, searchParams: item.searchParams,
    })),
  }
}

export async function saveProposal(
  sql: postgres.Sql,
  args: {
    conversationId: string; userId: string; turnId: string | null; round: number
    items: RehydratedItem[]; total: Money; notebook: Notebook
    gateOutcome: GateOutcomeLabel; reviewRounds: number; reviewIssues: string[]
    promptVersion: string; modelConfigId: string; parentProposalId: string | null
  },
): Promise<string> {
  const itinerary = toStoredItinerary(args.items)
  const [row] = await sql<{ id: string }[]>`
    insert into proposals
      (conversation_id, user_id, turn_id, itinerary, itinerary_schema_version,
       requirements_snapshot, total_minor, currency, gate_outcome, review_rounds,
       review_issues, prompt_version, model_config_id, parent_proposal_id)
    values
      (${args.conversationId}, ${args.userId}, ${args.turnId}, ${sql.json(itinerary as never)}, 1,
       ${sql.json(args.notebook as never)}, ${args.total.minor.toString()}, ${args.total.currency},
       ${args.gateOutcome}, ${args.reviewRounds}, ${sql.json(args.reviewIssues as never)},
       ${args.promptVersion}, ${args.modelConfigId}, ${args.parentProposalId})
    returning id`
  const id = row!.id
  if (args.turnId !== null) await attachProposal(sql, { turnId: args.turnId, round: args.round, proposalId: id })
  return id
}

type Row = {
  id: string; conversation_id: string; user_id: string; turn_id: string | null
  itinerary: StoredItinerary; total_minor: string; currency: string
  gate_outcome: GateOutcomeLabel; review_rounds: number; review_issues: string[]
  decision: 'accept' | 'reject' | null; decided_at: Date | null
  parent_proposal_id: string | null; created_at: Date
}

/** Scoped to the conversation: a proposal id from another conversation is "not found", never "forbidden". */
export async function loadProposal(
  sql: postgres.Sql, conversationId: string, proposalId: string,
): Promise<ProposalRow | null> {
  const rows = await sql<Row[]>`
    select id, conversation_id, user_id, turn_id, itinerary, total_minor, currency,
           gate_outcome, review_rounds, review_issues, decision, decided_at,
           parent_proposal_id, created_at
      from proposals where id = ${proposalId} and conversation_id = ${conversationId}`
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id, conversationId: r.conversation_id, userId: r.user_id, turnId: r.turn_id,
    itinerary: r.itinerary, totalMinor: BigInt(r.total_minor), currency: r.currency,
    gateOutcome: r.gate_outcome, reviewRounds: r.review_rounds, reviewIssues: r.review_issues,
    decision: r.decision, decidedAt: r.decided_at, parentProposalId: r.parent_proposal_id,
    createdAt: r.created_at,
  }
}

/**
 * Her decision, recorded once. Not a tool: the plan 4 route handler and the
 * demo both call this, so the cashier's 30-minute window has one clock.
 * `now` is injectable for tests; production passes nothing.
 */
export async function decideProposal(
  sql: postgres.Sql,
  args: {
    proposalId: string; conversationId: string
    decision: 'accept' | 'reject'; rejectReason?: string | null; now?: Date
  },
): Promise<void> {
  const now = args.now ?? new Date()
  const rows = await sql<{ decision: string | null }[]>`
    select decision from proposals where id = ${args.proposalId} and conversation_id = ${args.conversationId}`
  if (rows.length === 0) throw new Error(`decideProposal: proposal ${args.proposalId} not found in this conversation`)
  if (rows[0]!.decision !== null) throw new Error(`decideProposal: proposal ${args.proposalId} already decided`)
  const updated = await sql`
    update proposals
       set decision = ${args.decision}, decided_at = ${now}, reject_reason = ${args.rejectReason ?? null},
           accepted_total_minor = case when ${args.decision} = 'accept' then total_minor else null end,
           accepted_currency    = case when ${args.decision} = 'accept' then currency else null end
     where id = ${args.proposalId} and conversation_id = ${args.conversationId} and decision is null
    returning id`
  if (updated.length === 0) throw new Error(`decideProposal: proposal ${args.proposalId} already decided`)
}
```

Add to `src/repo/gateResults.ts`:

```ts
/** Points the gate rows of ONE round at the proposal they produced. Round-scoped: other rounds stay null. */
export async function attachProposal(
  sql: postgres.Sql, args: { turnId: string; round: number; proposalId: string },
): Promise<void> {
  await sql`update gate_results set proposal_id = ${args.proposalId}
             where turn_id = ${args.turnId} and round = ${args.round} and proposal_id is null`
}

/**
 * How many reviewer verdicts this turn has already recorded. Persisted before
 * any later step, so a crash cannot reset the round bound. Throws on a missing
 * row for the same reason `countPriorGateRuns` does.
 */
export async function countReviewerVerdicts(sql: postgres.Sql, turnId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from gate_results where turn_id = ${turnId} and gate = 'reviewer'`
  const row = rows[0]
  if (!row) throw new Error('countReviewerVerdicts: count returned no row; refusing to assume zero')
  return row.n
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm vitest run test/proposals-repo.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Discrimination check**

Remove `and round = ${args.round}` from `attachProposal`. Run: the "DIFFERENT round" test must fail. Restore. Change `decideProposal`'s `decision is null` guard to `true`; the "once" test must fail on the second call. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/repo/proposals.ts src/repo/gateResults.ts test/proposals-repo.test.ts
git commit -m "feat(repo): saveProposal, loadProposal, decideProposal; gate rows attach per round"
```

---

### Task 3: Structured output on the model client

**Files:**
- Modify: `src/model/client.ts` (`CallArgs.outputSchema`, `buildRequest`)
- Modify: `test/model-client.test.ts`
- Modify: `test/driver.live.test.ts` (one live pin)

**Interfaces:**
- Produces: `CallArgs.outputSchema?: Record<string, unknown>`; when set, `buildRequest` emits `output_config.format = { type: 'json_schema', schema }`.

- [ ] **Step 1: Write the failing shape tests** (append to the `buildRequest` describe in `test/model-client.test.ts`)

```ts
  it('puts a JSON schema under output_config.format with type json_schema, and nowhere else', () => {
    const schema = { type: 'object', properties: { approved: { type: 'boolean' } },
                     required: ['approved'], additionalProperties: false }
    const req = buildRequest({ ...base, outputSchema: schema })
    expect(req.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } })
    expect(req.output_format).toBeUndefined()          // the deprecated top-level name
  })

  it('emits no format when no schema is given, so the driver request is byte-identical to before', () => {
    const req = buildRequest(base)
    expect((req.output_config as Record<string, unknown>).format).toBeUndefined()
  })

  it('counts tokens for a structured request with the same format field', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false }
    const count = buildCountTokensRequest({ ...base, outputSchema: schema })
    expect((count.output_config as Record<string, unknown>).format).toEqual({ type: 'json_schema', schema })
  })
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run test/model-client.test.ts`
Expected: FAIL on the first and third new tests (`format` undefined).

- [ ] **Step 3: Implement**

In `CallArgs` add:

```ts
  /**
   * Structured output. Sent as `output_config.format = {type: 'json_schema',
   * schema}` — the canonical field (SDK 0.122 `OutputConfig.format`). NOT the
   * deprecated top-level `output_format`, and never an assistant prefill,
   * which 400s on Opus 5. Objects in the schema must carry
   * `additionalProperties: false`; the API rejects the request otherwise.
   */
  outputSchema?: Record<string, unknown>
```

In `buildRequest`, after the `effort` line:

```ts
  if (args.outputSchema !== undefined) {
    outputConfig.format = { type: 'json_schema', schema: args.outputSchema }
  }
```

`buildCountTokensRequest` derives from `buildRequest`, so it inherits the field. Confirm the test passes without touching it.

- [ ] **Step 4: Add the live pin** to `test/driver.live.test.ts` inside the existing `LIVE_MODEL` gated describe:

```ts
  it('the API accepts output_config.format and returns parseable JSON for the reviewer schema', async () => {
    const client = new Anthropic()
    const schema = { type: 'object', properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
                     required: ['approved', 'issues'], additionalProperties: false }
    const req = buildRequest({
      seat: SEATS.reviewer, system: 'Answer in the schema.', tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Approve this: a flight for €100.' }] }],
      outputSchema: schema,
    })
    const res = await client.messages.create(req as never)
    const text = res.content.find((b) => b.type === 'text')
    expect(text).toBeDefined()
    const parsed = JSON.parse((text as { text: string }).text)
    expect(typeof parsed.approved).toBe('boolean')
    expect(Array.isArray(parsed.issues)).toBe(true)
  }, 60_000)
```

Mirror the imports the file already uses for `Anthropic`, `SEATS`, `buildRequest`.

- [ ] **Step 5: Run, expect pass**

Run: `pnpm vitest run test/model-client.test.ts` → PASS. Run once: `LIVE_MODEL=1 pnpm vitest run test/driver.live.test.ts` → PASS (costs one Opus call). Report the request id in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/model/client.ts test/model-client.test.ts test/driver.live.test.ts
git commit -m "feat(model): structured output via output_config.format, pinned live"
```

---

### Task 4: The reviewer seat

**Files:**
- Create: `src/agents/reviewer.ts`
- Create: `src/agents/prompts/reviewer.md`
- Create: `test/reviewer.test.ts`

**Interfaces:**
- Consumes: `callModel`, `buildRequest`, `buildCountTokensRequest`, `estimateInputTokens` (`src/model/client.ts`); `reserve`, `reconcile`, `estimateMicros` (`src/repo/reservation.ts`); `recordModelCall`; `recordGateResults`; `firstCeilingReached` (`src/engine.ts`); `renderNotebook`; `formatMoney`.
- Produces:

```ts
export const MAX_REVIEW_ROUNDS = 2
export const REVIEW_SCHEMA: Record<string, unknown>          // JSON schema for the verdict
export type ReviewVerdict = { approved: boolean; issues: string[] }
export type ReviewResult =
  | { kind: 'verdict'; verdict: ReviewVerdict; costMicros: bigint }
  | { kind: 'skipped_limit'; costMicros: 0n }
export type ReviewDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }
export async function reviewOffer(
  deps: ReviewDeps,
  ctx: { conversationId: string; userId: string; turnId: string },
  args: { items: RehydratedItem[]; total: Money; notebook: Notebook; round: number },
): Promise<ReviewResult>
export function renderOfferForReview(items: RehydratedItem[], total: Money, now: Date): string
```

`reviewOffer` writes the `reviewer` gate row itself (one per call, at `args.round`).

- [ ] **Step 1: Write the prompt**

```md
<!-- src/agents/prompts/reviewer.md -->
You are the senior reviewer at a small travel agency. A planner has assembled an
offer for a traveller from real search results. Every price below was read from
the supplier's own response; none was written by the planner.

Read the offer against her notebook. Approve it only if you would put your own
name on it. Reject it when a component does not fit what she asked for, when the
components do not fit each other (a stay that ends before the return flight, a
flight into a city the stay is not in), when a constraint she stated is broken,
or when the trade-off the planner made is one she did not ask for.

Answer in the schema you were given. `issues` is empty when you approve, and
when you reject it names each problem in one sentence she could act on. Do not
restate prices; do not propose alternatives; do not address the planner.
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/reviewer.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { reviewOffer, renderOfferForReview, MAX_REVIEW_ROUNDS } from '../src/agents/reviewer.js'
import { recordResults } from '../src/repo/toolResults.js'
import { runGates } from '../src/gates/pipeline.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const verdictResponse = (v: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'req_r', usage,
})
const refusal = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null },
  model: 'claude-opus-5', _request_id: 'req_r', usage }

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000a${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                        values (${c!.id}, ${userId}, ${'r' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const p = { ...params, flexDays: Number(n) }
  const items = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(p)
  await recordResults(sql, { conversationId, userId, turnId, params: p, items })
  const outcome = await runGates(sql, { conversationId, turnId, round: 0, now: NOW,
    refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' }],
    notebook: { budget: money(10_000_00n, 'EUR'), window: null, currency: 'EUR' } })
  if (!outcome.ok) throw new Error('seed')
  return { userId, conversationId, turnId, outcome }
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) =>
  ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })

describeDb('reviewer seat', () => {
  it('sends the reviewer seat with the JSON schema, and records an approving verdict row', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const create = vi.fn().mockResolvedValue(verdictResponse({ approved: true, issues: [] }))
      const r = await reviewOffer(deps(sql, create), s, { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      expect(r.kind).toBe('verdict')
      if (r.kind !== 'verdict') throw new Error('unreachable')
      expect(r.verdict).toEqual({ approved: true, issues: [] })
      const sent = create.mock.calls[0]![0] as Record<string, unknown>
      expect(sent.model).toBe('claude-opus-5')
      expect((sent.output_config as Record<string, unknown>).format).toMatchObject({ type: 'json_schema' })
      const [row] = await sql`select passed, detail, round from gate_results where turn_id = ${s.turnId} and gate = 'reviewer'`
      expect(row).toMatchObject({ passed: true, detail: null, round: 0 })
      const [mc] = await sql`select seat, capture_policy, prompt_version, cost_micros from model_calls where turn_id = ${s.turnId}`
      expect(mc).toMatchObject({ seat: 'reviewer', capture_policy: 'full', prompt_version: 'reviewer@1' })
      expect(BigInt(mc!.cost_micros as string)).toBe(r.costMicros)
      expect(r.costMicros).toBe(6_000n)   // 1000*5 + 40*25
    })
  })

  it('reads a REFUSAL as a rejection, never approval', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const r = await reviewOffer(deps(sql, vi.fn().mockResolvedValue(refusal)), s,
        { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      if (r.kind !== 'verdict') throw new Error('unreachable')
      expect(r.verdict.approved).toBe(false)
      expect(r.verdict.issues[0]).toMatch(/refus/i)
      expect(r.costMicros).toBe(0n)
      const [row] = await sql`select passed from gate_results where turn_id = ${s.turnId} and gate = 'reviewer'`
      expect(row!.passed).toBe(false)
    })
  })

  it.each([
    ['not JSON', verdictResponse('yes')],
    ['wrong shape', verdictResponse({ ok: true })],
    ['approved with issues', verdictResponse({ approved: true, issues: ['x'] })],
    ['no text block', { ...verdictResponse({}), content: [] }],
  ])('reads %s as a rejection with a synthetic issue', async (_, resp) => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const r = await reviewOffer(deps(sql, vi.fn().mockResolvedValue(resp)), s,
        { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      if (r.kind !== 'verdict') throw new Error('unreachable')
      expect(r.verdict.approved).toBe(false)
      expect(r.verdict.issues).toHaveLength(1)
    })
  })

  it('reserves before the call and reconciles to the real cost', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      let during = 0n
      const create = vi.fn().mockImplementation(async () => {
        const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
        during = BigInt(c!.spend_usd_micros as string)
        return verdictResponse({ approved: false, issues: ['stay ends before the flight home'] })
      })
      const r = await reviewOffer(deps(sql, create), s, { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      const [after] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(during).toBeGreaterThan(0n)
      expect(BigInt(after!.spend_usd_micros as string)).toBe(r.costMicros)
    })
  })

  it('skips the review and refunds when the reservation would cross a ceiling', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const create = vi.fn()
      const r = await reviewOffer(deps(sql, create), s, { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      expect(r.kind).toBe('skipped_limit')
      expect(create).not.toHaveBeenCalled()
      const [after] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(after!.spend_usd_micros as string)).toBe(DEFAULT_LIMITS.conversationCeilingMicros)
      const rows = await sql`select 1 from gate_results where turn_id = ${s.turnId} and gate = 'reviewer'`
      expect(rows).toHaveLength(0)
    })
  })

  it('renders every price with its age and never a model-supplied value', () => {
    const items = [{ ref: { sourceId: 'X', quantity: 1, slot: 'outbound' },
      item: { sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'BER-FAO', price: money(45_400n, 'EUR'),
        priceBasis: 'total' as const, fetchedAt: new Date(NOW.getTime() - 5 * 60_000), ttlSeconds: 900, bookingUrl: null,
        detail: { kind: 'flight' as const, outbound: { from: 'BER', to: 'FAO', departureLocal: '2026-09-12T08:00:00', arrivalLocal: '2026-09-12T11:30:00', stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', carriers: ['ZZ'], flightNumbers: ['ZZ100'] }, inbound: null, baggage: { personalItem: 2, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 12600, selfTransfer: false },
        searchParams: null }, lineTotal: money(45_400n, 'EUR') }]
    const text = renderOfferForReview(items, money(45_400n, 'EUR'), NOW)
    expect(text).toContain('€454.00')
    expect(text).toMatch(/5 min/)
    expect(text).toContain('ZZ100')
  })

  it('exposes the round bound as a constant of 2', () => { expect(MAX_REVIEW_ROUNDS).toBe(2) })
})
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm vitest run test/reviewer.test.ts`
Expected: FAIL, cannot resolve `../src/agents/reviewer.js`.

- [ ] **Step 4: Implement**

```ts
// src/agents/reviewer.ts
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { z } from 'zod'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import {
  buildCountTokensRequest, buildRequest, callModel, estimateInputTokens,
  type CallArgs, type ModelResult, type Transport,
} from '../model/client.js'
import { costMicros } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { recordGateResults } from '../repo/gateResults.js'
import { renderNotebook } from '../repo/notebook.js'
import { formatMoney, type Money } from '../money.js'
import { sanitizeSourceId } from '../sanitize.js'
import type { RehydratedItem } from '../gates/types.js'
import type { Notebook } from '../notebook.js'

const SYSTEM = readFileSync(new URL('./prompts/reviewer.md', import.meta.url), 'utf8')

/** Spec section 5: `rounds < MAX_ROUNDS`. Two verdicts, then ship unapproved. */
export const MAX_REVIEW_ROUNDS = 2

const Verdict = z.strictObject({ approved: z.boolean(), issues: z.array(z.string().max(500)).max(20) })
export type ReviewVerdict = z.infer<typeof Verdict>

/** Hand-written rather than `z.toJSONSchema(Verdict)`: the API rejects `maxItems`/`maxLength`, which zod would emit. */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
  required: ['approved', 'issues'],
  additionalProperties: false,
}

export type ReviewResult =
  | { kind: 'verdict'; verdict: ReviewVerdict; costMicros: bigint }
  | { kind: 'skipped_limit'; costMicros: 0n }

export type ReviewDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * The offer as the reviewer reads it. Prices are the CORPUS's (rehydrated), so
 * showing them is not a leak; each carries its age because a stale price is a
 * reviewable fault. Ids are sanitised: a supplier id is untrusted text.
 */
export function renderOfferForReview(items: RehydratedItem[], total: Money, now: Date): string {
  const lines = items.map(({ ref, item }) => {
    const ageMin = Math.max(0, Math.round((now.getTime() - item.fetchedAt.getTime()) / 60_000))
    const d = item.detail
    const what = d.kind === 'flight'
      ? `${d.outbound.from}→${d.outbound.to} ${d.outbound.departureLocal} flights ${d.outbound.flightNumbers.join('+')}`
        + (d.inbound ? `, back ${d.inbound.departureLocal} flights ${d.inbound.flightNumbers.join('+')}` : '')
        + `, ${d.outbound.stops} stop(s)`
      : `${d.checkIn} to ${d.checkOut}, ${d.nights} night(s)`
    return `- ${ref.slot}: ${sanitizeSourceId(item.sourceId)} — ${item.name} — ${what} — `
         + `${formatMoney(item.price)} (${item.priceBasis}, fetched ${ageMin} min ago)`
  })
  return `## The offer\n\n${lines.join('\n')}\n\nServer total: ${formatMoney(total)}`
}

/**
 * One Opus call, charged like the driver's: reserve, call, reconcile, record.
 * Writes exactly one `reviewer` row in gate_results at `args.round`.
 *
 * Never approves by accident: a refusal, a malformed body, or `approved: true`
 * with issues is a rejection carrying a synthetic issue that names the cause.
 * Spec section 8: "a refused reviewer call is never read as approval."
 */
export async function reviewOffer(
  deps: ReviewDeps,
  ctx: { conversationId: string; userId: string; turnId: string },
  args: { items: RehydratedItem[]; total: Money; notebook: Notebook; round: number },
): Promise<ReviewResult> {
  const { sql } = deps
  const seat = SEATS.reviewer
  const now = new Date(deps.now())
  const callArgs: CallArgs = {
    seat, system: SYSTEM, tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: renderOfferForReview(args.items, args.total, now) }] }],
    suffix: renderNotebook(args.notebook) || '## The notebook, as recorded\n\n(empty)',
    outputSchema: REVIEW_SCHEMA,
  }

  const inputTokens = deps.transport.countTokens
    ? (await deps.transport.countTokens(buildCountTokensRequest(callArgs))).input_tokens
    : estimateInputTokens(callArgs)
  const reserved = estimateMicros(seat, inputTokens)
  const { conversationMicros, dailyMicros, day } = await reserve(sql, {
    userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved,
  })
  const refund = () => reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day })

  // Deviation 3 in the plan: a ceiling here skips the review rather than
  // throwing out of run(); the next driver step fails the turn with her words.
  if (firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits) !== null) {
    await refund()
    return { kind: 'skipped_limit', costMicros: 0n }
  }

  let result: ModelResult
  try {
    result = await callModel(deps.transport, callArgs, deps.now)
  } catch (err) {
    if (classifyError(err).billed === 'no') await refund()
    throw err
  }
  const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)
  await reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day })
  await recordModelCall(sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'reviewer', seatConfig: seat, result,
    systemPrompt: callArgs.system, userPrompt: callArgs.messages[0]!.content.map((b) => b.type === 'text' ? b.text : '').join(''),
    requestShape: buildRequest(callArgs), thinkingMode: 'adaptive', costMicros: actual,
  })

  const verdict = parseVerdict(result)
  await recordGateResults(sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, proposalId: null, round: args.round,
    results: [verdict.approved
      ? { gate: 'reviewer', passed: true, detail: null, sourceIds: [] }
      : { gate: 'reviewer', passed: false, detail: verdict.issues.join(' '), sourceIds: [] }],
  })
  return { kind: 'verdict', verdict, costMicros: actual }
}

function parseVerdict(result: ModelResult): ReviewVerdict {
  if (result.kind === 'refused') return { approved: false, issues: ['The reviewer refused to assess this offer.'] }
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim()
  if (text.length === 0) return { approved: false, issues: ['The reviewer returned no verdict.'] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { approved: false, issues: ['The reviewer\'s verdict was not readable.'] } }
  const parsed = Verdict.safeParse(raw)
  if (!parsed.success) return { approved: false, issues: ['The reviewer\'s verdict did not match the expected shape.'] }
  if (parsed.data.approved && parsed.data.issues.length > 0) {
    return { approved: false, issues: ['The reviewer approved while listing issues; treated as a rejection: ' + parsed.data.issues.join(' ')] }
  }
  return parsed.data
}
```

Check `SEATS.reviewer.maxTokens` is 8_000 and `capturePolicyFor('reviewer')` is `'full'` (both already true; do not change).

- [ ] **Step 5: Run, expect pass**

Run: `pnpm vitest run test/reviewer.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Discrimination check**

In `parseVerdict`, make the refusal branch return `{ approved: true, issues: [] }`; the refusal test must fail. Restore. Remove the `firstCeilingReached` block; the ceiling test must fail (create called). Restore.

- [ ] **Step 7: Commit**

```bash
git add src/agents/reviewer.ts src/agents/prompts/reviewer.md test/reviewer.test.ts
git commit -m "feat(reviewer): senior reviewer seat — structured verdict, never approves by accident"
```

---

### Task 5: The shared proposal path, wired into `propose_itinerary`

**Files:**
- Create: `src/agents/proposalPath.ts`
- Modify: `src/agents/driver.ts` (the `propose_itinerary` case; `asToolStep` gains `spent`)
- Modify: `src/worker.ts` (`AgentStep.tool.spent`, folded after `run()`)
- Modify: `src/engine.ts`, `src/worker.ts`, `scripts/demo.ts`, `test/engine.test.ts`, `test/completion.test.ts`, `test/claim.test.ts`, `test/driver.test.ts` (remove `reviewRounds` from `TurnState`)
- Create: `test/proposal-path.test.ts`
- Modify: `test/driver.test.ts` (existing `propose_itinerary` tests now need a reviewer response)
- Modify: `test/worker.test.ts` (one test for `spent`)

**Interfaces:**
- Consumes: `runGates`, `reviewOffer`, `MAX_REVIEW_ROUNDS`, `countReviewerVerdicts`, `saveProposal`, `constraintsFromNotebook`, `formatMoney`, `sanitizeSourceId`.
- Produces:

```ts
// src/agents/proposalPath.ts
export type ProposalPathDeps = ReviewDeps                     // { sql, transport, limits, now }
export async function runProposalPath(
  deps: ProposalPathDeps,
  ctx: { conversationId: string; userId: string; turnId: string },
  spent: { micros: bigint },
  args: { refs: unknown; notebook: Notebook; round: number; parentProposalId: string | null },
): Promise<string>                                            // the tool result text
// src/worker.ts
| { kind: 'tool'; ...; spent?: { micros: bigint } }
```

- [ ] **Step 1: Remove `TurnState.reviewRounds`**

In `src/engine.ts` change to `export type TurnState = { step: number; messages: LoopMessage[] }`. Fix `EMPTY` in `src/worker.ts`, the literal in `scripts/demo.ts` (three sites), and every `reviewRounds: 0` in `test/engine.test.ts`, `test/completion.test.ts`, `test/claim.test.ts`, `test/driver.test.ts`. Run `pnpm typecheck` — clean. Run `pnpm test` — all green. Commit:

```bash
git commit -am "refactor(engine): drop TurnState.reviewRounds — review rounds derive from gate_results"
```

- [ ] **Step 2: Write the failing proposal-path tests**

```ts
// test/proposal-path.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { recordResults } from '../src/repo/toolResults.js'
import { recordGateResults } from '../src/repo/gateResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const verdict = (approved: boolean, issues: string[] = []) => ({
  content: [{ type: 'text', text: JSON.stringify({ approved, issues }) }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'req_r', usage,
})
const withBudget = (nb: Notebook): Notebook =>
  ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000b${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                        values (${c!.id}, ${userId}, ${'q' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const p = { ...params, flexDays: Number(n) }
  const items = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(p)
  await recordResults(sql, { conversationId, userId, turnId, params: p, items })
  return { userId, conversationId, turnId, items }
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) =>
  ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })
const refsOf = (s: { items: { sourceId: string }[] }) => [{ sourceId: s.items[0]!.sourceId, quantity: 1, slot: 'outbound' }]

describeDb('proposal path', () => {
  it('gates → reviewer → saved proposal, and the reply carries the proposal id', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const spent = { micros: 0n }
      const create = vi.fn().mockResolvedValue(verdict(true))
      const out = await runProposalPath(deps(sql, create), s, spent,
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      const [p] = await sql`select id, gate_outcome, review_rounds, parent_proposal_id from proposals where conversation_id = ${s.conversationId}`
      expect(out).toContain(`proposal_id ${p!.id}`)
      expect(out).toMatch(/approved/i)
      expect(p!.gate_outcome).toBe('approved')
      expect(p!.review_rounds).toBe(1)
      expect(spent.micros).toBe(6_000n)
      const rows = await sql`select gate, proposal_id from gate_results where turn_id = ${s.turnId} and round = 0`
      expect(rows).toHaveLength(8)
      expect(rows.every((r) => r.proposal_id === p!.id)).toBe(true)
    })
  })

  it('a gate rejection returns without calling the reviewer or saving anything', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const create = vi.fn()
      const out = await runProposalPath(deps(sql, create), s, { micros: 0n },
        { refs: [{ sourceId: 'INVENTED', quantity: 1, slot: 'outbound' }], notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      expect(out).toMatch(/rejected/i)
      expect(create).not.toHaveBeenCalled()
      expect(await sql`select 1 from proposals where conversation_id = ${s.conversationId}`).toHaveLength(0)
    })
  })

  it('a reviewer rejection below the bound asks for a revision and saves nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const out = await runProposalPath(deps(sql, vi.fn().mockResolvedValue(verdict(false, ['stay ends before the return flight']))), s, { micros: 0n },
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      expect(out).toMatch(/^Revise: stay ends before the return flight/)
      expect(await sql`select 1 from proposals where conversation_id = ${s.conversationId}`).toHaveLength(0)
    })
  })

  it('at the bound, a rejection ships UNAPPROVED with the issues on the row and in the reply', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      // Two prior verdicts this turn (rounds 0 and 1) — persisted, not in memory.
      for (const round of [0, 1]) {
        await recordGateResults(sql, { conversationId: s.conversationId, turnId: s.turnId, proposalId: null, round,
          results: [{ gate: 'reviewer', passed: false, detail: 'earlier', sourceIds: [] }] })
      }
      const out = await runProposalPath(deps(sql, vi.fn().mockResolvedValue(verdict(false, ['still wrong']))), s, { micros: 0n },
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 2, parentProposalId: null })
      const [p] = await sql`select gate_outcome, review_rounds, review_issues from proposals where conversation_id = ${s.conversationId}`
      expect(p!.gate_outcome).toBe('shipped_unapproved')
      expect(p!.review_rounds).toBe(3)
      expect(p!.review_issues).toEqual(['still wrong'])
      expect(out).toMatch(/not approved/i)
      expect(out).toContain('still wrong')
    })
  })

  it('a skipped review (ceiling) ships unapproved with the reason recorded', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const out = await runProposalPath(deps(sql, vi.fn()), s, { micros: 0n },
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      const [p] = await sql`select gate_outcome, review_issues from proposals where conversation_id = ${s.conversationId}`
      expect(p!.gate_outcome).toBe('shipped_unapproved')
      expect(p!.review_issues).toEqual(['reviewer skipped: spending limit reached'])
      expect(out).toMatch(/not approved/i)
    })
  })

  it('records the parent on a revision', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06')
      const create = vi.fn().mockResolvedValue(verdict(true))
      await runProposalPath(deps(sql, create), s, { micros: 0n }, { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      const [parent] = await sql`select id from proposals where conversation_id = ${s.conversationId}`
      await runProposalPath(deps(sql, create), s, { micros: 0n }, { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 1, parentProposalId: parent!.id })
      const [child] = await sql`select parent_proposal_id from proposals where conversation_id = ${s.conversationId} and parent_proposal_id is not null`
      expect(child!.parent_proposal_id).toBe(parent!.id)
    })
  })
})
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm vitest run test/proposal-path.test.ts` → FAIL, cannot resolve module.

- [ ] **Step 4: Implement the path**

```ts
// src/agents/proposalPath.ts
import { constraintsFromNotebook, runGates } from '../gates/pipeline.js'
import { countReviewerVerdicts } from '../repo/gateResults.js'
import { saveProposal, type GateOutcomeLabel } from '../repo/proposals.js'
import { SEATS } from '../model/seats.js'
import { formatMoney } from '../money.js'
import { sanitizeSourceId } from '../sanitize.js'
import { MAX_REVIEW_ROUNDS, reviewOffer, type ReviewDeps } from './reviewer.js'
import type { Notebook } from '../notebook.js'

export type ProposalPathDeps = ReviewDeps

/**
 * Spec section 5, as one function shared by `propose_itinerary` and
 * `revise_component`: gates, then the reviewer, then the row. Returns the text
 * the MODEL reads; nothing here is shown to her directly.
 *
 * `spent` is the tool step's accumulator (src/worker.ts): the reviewer's Opus
 * call is debited by reviewOffer through reserve/reconcile, and this is how the
 * turn total learns of it. It is never passed to recordSpend.
 *
 * `round` is the caller's — derived from tool_calls by countPriorGateRuns — and
 * is what keeps the seven-plus-one gate rows unique per turn (migration 0013).
 */
export async function runProposalPath(
  deps: ProposalPathDeps,
  ctx: { conversationId: string; userId: string; turnId: string },
  spent: { micros: bigint },
  args: { refs: unknown; notebook: Notebook; round: number; parentProposalId: string | null },
): Promise<string> {
  const outcome = await runGates(deps.sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, refs: args.refs,
    notebook: constraintsFromNotebook(args.notebook), now: new Date(deps.now()), round: args.round,
  })
  if (!outcome.ok) {
    return 'The proposal was rejected. Fix exactly these and propose again:\n'
      + outcome.violations
          .map((v) => `- ${v.gate} (${v.sourceIds.map(sanitizeSourceId).join(', ') || 'no ids'}): ${v.detail}`)
          .join('\n')
  }

  const priorVerdicts = await countReviewerVerdicts(deps.sql, ctx.turnId)
  const review = await reviewOffer(deps, ctx, { items: outcome.items, total: outcome.total, notebook: args.notebook, round: args.round })
  spent.micros += review.costMicros

  let gateOutcome: GateOutcomeLabel
  let issues: string[]
  if (review.kind === 'skipped_limit') {
    gateOutcome = 'shipped_unapproved'
    issues = ['reviewer skipped: spending limit reached']
  } else if (review.verdict.approved) {
    gateOutcome = 'approved'
    issues = []
  } else if (priorVerdicts < MAX_REVIEW_ROUNDS) {
    // Below the bound: no row. The model fixes what the reviewer named and
    // proposes again, which is the next round.
    return `Revise: ${review.verdict.issues.join('; ')}`
  } else {
    gateOutcome = 'shipped_unapproved'
    issues = review.verdict.issues
  }

  const reviewRounds = review.kind === 'skipped_limit' ? priorVerdicts : priorVerdicts + 1
  const proposalId = await saveProposal(deps.sql, {
    conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, round: args.round,
    items: outcome.items, total: outcome.total, notebook: args.notebook,
    gateOutcome, reviewRounds, reviewIssues: issues,
    promptVersion: SEATS.driver.promptVersion, modelConfigId: SEATS.driver.modelConfigId,
    parentProposalId: args.parentProposalId,
  })
  const ids = outcome.items.map((i) => sanitizeSourceId(i.item.sourceId)).join(', ')
  const head = `Saved as proposal_id ${proposalId}. Total ${formatMoney(outcome.total)}. Items: ${ids}.`
  if (gateOutcome === 'approved') {
    return `${head} The reviewer approved it. Tell her what you chose and why, and that she can accept it or ask for a component to change.`
  }
  return `${head} The reviewer did NOT approve it and the rounds are used up: ${issues.join('; ')}. `
       + 'Tell her what you chose, and pass on the reviewer\'s concerns in her words — she decides.'
}
```

With `MAX_REVIEW_ROUNDS = 2`: `priorVerdicts` is 0 on the first verdict and 1 on the second, so both return `Revise:`; the third (`priorVerdicts = 2`) ships unapproved. The Task 5 test "at the bound" seeds two prior verdicts for exactly this.

- [ ] **Step 5: Wire it into the driver and the worker**

In `src/worker.ts`, add to the `tool` variant:

```ts
      /**
       * Micros the tool debited ITSELF during run() — a reviewer call inside
       * propose_itinerary. Read after run() resolves and added to the turn
       * total; never passed to recordSpend. Same rule as recordedMicros, one
       * step later in time because the amount is not known before run().
       */
      spent?: { micros: bigint }
```

and in `loop()`'s fresh path, immediately after `await finishToolCall(...)`:

```ts
      if (step.spent !== undefined) turnSpend.total += step.spent.micros
```

In `src/agents/driver.ts`: replace the `countPriorProposals` import with `countPriorGateRuns` (Task 6 renames it; until then keep the old name and rename in Task 6), import `runProposalPath`, and change `asToolStep` to allocate `const spent = { micros: 0n }` and set `spent` on the step; pass `spent` into `execute`. The case becomes:

```ts
    case 'propose_itinerary': {
      const { refs } = input as { refs: unknown[] }
      const round = await countPriorProposals(sql, ctx.turnId, callId)
      return runProposalPath(deps, ctx, spent, { refs, notebook, round, parentProposalId: null })
    }
```

`DriverDeps` already has `sql`, `transport`, `limits`, `now`, so it satisfies `ProposalPathDeps` structurally.

- [ ] **Step 6: Update the driver tests that propose**

In `test/driver.test.ts`, the test `runs propose_itinerary through the gates and reports a pass` now makes two model calls. Change its mock to
`vi.fn().mockResolvedValueOnce(toolResponse('propose_itinerary', {...})).mockResolvedValueOnce(verdictResponse)` where `verdictResponse` is the JSON text response shape from `test/reviewer.test.ts` (copy the helper into this file). Assert additionally: `expect(out).toContain('proposal_id')`, one `proposals` row exists, `step.spent!.micros` is `6_000n`, and the `model_calls` rows are `['driver', 'reviewer']`. The two `round` tests use an invented id and are rejected by provenance before the reviewer runs; they need no change.

Add to `test/worker.test.ts`, next to the existing tool-step test:

```ts
  it('adds a tool step\'s self-debited spent.micros to the turn total, once, without recordSpend', async () => {
    // Agent: one tool step whose run() bumps spent by 700n and returns 'ok'; then a message.
    // Assert turns.spend_usd_micros === costMicros + recordedMicros + 700n and
    // conversations.spend_usd_micros is NOT increased by the 700n (the tool would have
    // reserved/reconciled that itself; here it did not, so the conversation column must not move).
  })
```

Write it with the file's existing `runTurn` harness and fake agent pattern; the assertion pair is the test. Break: remove the `if (step.spent ...)` line; the first assertion fails.

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/agents/proposalPath.ts src/agents/driver.ts src/worker.ts test/proposal-path.test.ts test/driver.test.ts test/worker.test.ts
git commit -m "feat(gates): propose_itinerary saves a reviewed proposal; reviewer spend reaches the turn total"
```

---

### Task 6: `revise_component`

**Files:**
- Modify: `src/repo/toolCalls.ts` (`countPriorProposals` → `countPriorGateRuns`)
- Create: `src/tools/revise.ts`
- Modify: `src/tools/registry.ts` (schema + `DESK_TOOLS`), `src/agents/driver.ts` (case), `test/tools.test.ts` (fixture)
- Create: `test/revise.test.ts`
- Modify: `test/driver.test.ts` (rename in the two round tests' comments only)

**Interfaces:**
- Produces:

```ts
// src/tools/registry.ts
export const ReviseComponent = z.strictObject({
  proposalId: z.uuid(),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('swap'), slot: z.enum(SLOT_NAMES), sourceId: z.string().min(1).max(512) }),
    z.strictObject({ kind: z.literal('shift'), days: z.int().min(-14).max(14).refine((d) => d !== 0, { message: 'days must be non-zero' }) }),
  ]),
})
// src/tools/revise.ts
export type ReviseInput = z.infer<typeof ReviseComponent>
export type ReviseResult =
  | { ok: true; refs: ItemRef[]; parentProposalId: string }
  | { ok: false; reason: string }
export async function buildRevisedRefs(sql, conversationId: string, input: ReviseInput): Promise<ReviseResult>
// src/repo/toolCalls.ts
export const GATE_RUN_TOOLS = ['propose_itinerary', 'revise_component'] as const
export async function countPriorGateRuns(sql, turnId: string, callId: string): Promise<number>
```

`SLOT_NAMES` must be exported from `src/gates/rehydrateGate.ts` (it is currently module-private).

- [ ] **Step 1: Rename the counter**

In `src/repo/toolCalls.ts` rename `countPriorProposals` to `countPriorGateRuns`, add `export const GATE_RUN_TOOLS = ['propose_itinerary', 'revise_component'] as const`, and change the query to `and name = any(${[...GATE_RUN_TOOLS]})`. Rewrite the doc comment's PRECONDITION paragraph to say the precondition is now met and that any third gate-running tool must be added to `GATE_RUN_TOOLS`. Update the import and call in `src/agents/driver.ts`. Typecheck clean; tests green. Commit `refactor(repo): countPriorGateRuns counts every gate-running tool`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/revise.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { buildRevisedRefs } from '../src/tools/revise.js'
import { countPriorGateRuns } from '../src/repo/toolCalls.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const flight: FlightSearch = { kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false }
const hotel: HotelSearch = { kind: 'hotel', query: 'Faro beach', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2, currency: 'EUR' }
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const approve = () => ({ content: [{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r', usage })
const withBudget = (nb: Notebook): Notebook => ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000c${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'v' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const fp = { ...flight, flexDays: Number(n) }
  const flights = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(fp)
  const hotels = await new MockSupplier({ kind: 'hotel', now: () => NOW }).search({ ...hotel, query: hotel.query + n })
  await recordResults(sql, { conversationId, userId, turnId, params: fp, items: flights })
  await recordResults(sql, { conversationId, userId, turnId, params: { ...hotel, query: hotel.query + n }, items: hotels })
  const deps = { sql, transport: { create: vi.fn().mockResolvedValue(approve()) }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() }
  const ctx = { conversationId, userId, turnId }
  await runProposalPath(deps, ctx, { micros: 0n }, { notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null,
    refs: [{ sourceId: flights[0]!.sourceId, quantity: 1, slot: 'outbound' }, { sourceId: hotels[0]!.sourceId, quantity: 1, slot: 'stay' }] })
  const [p] = await sql`select id from proposals where conversation_id = ${conversationId}`
  return { ...ctx, deps, flights, hotels, proposalId: p!.id as string }
}

describeDb('revise_component', () => {
  it('swap replaces exactly one slot and keeps the others', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: s.hotels[1]!.sourceId } })
      expect(r).toEqual({ ok: true, parentProposalId: s.proposalId, refs: [
        { sourceId: s.flights[0]!.sourceId, quantity: 1, slot: 'outbound' },
        { sourceId: s.hotels[1]!.sourceId, quantity: 1, slot: 'stay' } ] })
    })
  })

  it('swap of a slot the proposal does not have is a readable refusal', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'inbound', sourceId: s.flights[1]!.sourceId } })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toMatch(/inbound/)
    })
  })

  it('refuses a proposal from another conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '03'); const b = await seed(sql, '04')
      const r = await buildRevisedRefs(sql, b.conversationId, { proposalId: a.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: b.hotels[1]!.sourceId } })
      expect(r).toEqual({ ok: false, reason: expect.stringMatching(/no proposal/i) })
    })
  })

  it('shift resolves every slot from the corpus when the shifted dates were searched', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      // Search the shifted dates so the corpus holds them.
      const fp = { ...flight, flexDays: 5, departureDate: '2026-09-14', returnDate: '2026-09-21' }
      const hp = { ...hotel, query: hotel.query + '05', checkIn: '2026-09-14', checkOut: '2026-09-21' }
      const f2 = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(fp)
      const h2 = await new MockSupplier({ kind: 'hotel', now: () => NOW }).search(hp)
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: fp, items: f2 })
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: hp, items: h2 })
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'shift', days: 2 } })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.refs.map((x) => x.slot).sort()).toEqual(['outbound', 'stay'])
      // The mock derives identity from index i; item 0 of the shifted search has the same flight numbers as item 0 of the original.
      expect(r.refs.find((x) => x.slot === 'outbound')!.sourceId).toBe(f2[0]!.sourceId)
      expect(r.refs.find((x) => x.slot === 'stay')!.sourceId).toBe(h2[0]!.sourceId)
    })
  })

  it('shift names every slot it could not resolve and calls no supplier', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'shift', days: 3 } })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toMatch(/outbound/); expect(r.reason).toMatch(/stay/); expect(r.reason).toMatch(/search/i)
    })
  })

  it('a revise after a propose lands at round 1 with its own reviewer row and lineage', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07')
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_p', 'propose_itinerary', 'done')`
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_r', 'revise_component', 'pending')`
      const round = await countPriorGateRuns(sql, s.turnId, 'toolu_r')
      expect(round).toBe(1)
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: s.hotels[2]!.sourceId } })
      if (!r.ok) throw new Error('unreachable')
      const out = await runProposalPath(s.deps, s, { micros: 0n }, { refs: r.refs, notebook: withBudget(emptyNotebook()), round, parentProposalId: r.parentProposalId })
      expect(out).toContain('proposal_id')
      const rows = await sql`select distinct round from gate_results where turn_id = ${s.turnId} order by round`
      expect(rows.map((x) => x.round)).toEqual([0, 1])
      const [child] = await sql`select parent_proposal_id from proposals where conversation_id = ${s.conversationId} and parent_proposal_id is not null`
      expect(child!.parent_proposal_id).toBe(s.proposalId)
    })
  })

  it('COLLIDES when a revise re-runs the gates at a round already used — the index is load-bearing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '08')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: s.hotels[2]!.sourceId } })
      if (!r.ok) throw new Error('unreachable')
      await expect(runProposalPath(s.deps, s, { micros: 0n }, { refs: r.refs, notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: r.parentProposalId }))
        .rejects.toThrow(/gate_results_one_row_per_gate_per_round/)
    })
  })
})
```

- [ ] **Step 3: Run, expect failure** — `pnpm vitest run test/revise.test.ts` → cannot resolve `../src/tools/revise.js`.

- [ ] **Step 4: Implement**

Export `SLOT_NAMES` from `src/gates/rehydrateGate.ts`. Add `ReviseComponent` to `src/tools/registry.ts` (import `SLOT_NAMES`), register:

```ts
  revise_component: { name: 'revise_component', door: 'code', schema: ReviseComponent,
    description: 'Change ONE component of a saved proposal by proposal_id: swap the item in a slot for another search-result id, or shift every date by N days (only works if you have already searched the shifted dates). Runs the full gates and reviewer again and saves a new proposal.' },
```

and add `'revise_component'` to `DESK_TOOLS.planning`. Add the fixture in `test/tools.test.ts`:
`revise_component: { proposalId: '00000000-0000-4000-8000-000000000001', change: { kind: 'swap', slot: 'stay', sourceId: 'KIWI-1' } }`.

```ts
// src/tools/revise.ts
import type postgres from 'postgres'
import type { z } from 'zod'
import type { ReviseComponent } from './registry.js'
import type { ItemRef } from '../gates/types.js'
import { loadProposal, type StoredItineraryItem } from '../repo/proposals.js'
import { sanitizeSourceId } from '../sanitize.js'

export type ReviseInput = z.infer<typeof ReviseComponent>
export type ReviseResult =
  | { ok: true; refs: ItemRef[]; parentProposalId: string }
  | { ok: false; reason: string }

/**
 * Spec section 4: "scoped change to one component of an existing proposal
 * without a full re-plan." A code door over the corpus: it reads the parent's
 * itinerary and produces a NEW reference list. It never calls a supplier and
 * never trusts a value on the parent row beyond its ids and dates — the gates
 * rehydrate everything again on the way to the new row.
 */
export async function buildRevisedRefs(
  sql: postgres.Sql, conversationId: string, input: ReviseInput,
): Promise<ReviseResult> {
  const parent = await loadProposal(sql, conversationId, input.proposalId)
  if (parent === null) return { ok: false, reason: `No proposal ${input.proposalId} in this conversation.` }
  if (parent.itinerary.schemaVersion !== 1) return { ok: false, reason: 'This proposal was saved in a shape this desk cannot revise.' }
  const items = parent.itinerary.items

  if (input.change.kind === 'swap') {
    const { slot, sourceId } = input.change
    if (!items.some((i) => i.slot === slot)) {
      return { ok: false, reason: `Proposal has no "${slot}" slot; its slots are ${items.map((i) => i.slot).join(', ')}.` }
    }
    return {
      ok: true, parentProposalId: parent.id,
      refs: items.map((i) => ({ sourceId: i.slot === slot ? sourceId : i.sourceId, quantity: i.quantity, slot: i.slot })),
    }
  }

  const { days } = input.change
  const unresolved: string[] = []
  const refs: ItemRef[] = []
  for (const i of items) {
    const id = await findShifted(sql, conversationId, i, days)
    if (id === null) unresolved.push(i.slot)
    else refs.push({ sourceId: id, quantity: i.quantity, slot: i.slot })
  }
  if (unresolved.length > 0) {
    return { ok: false, reason: `No search results for the shifted dates in slot(s) ${unresolved.join(', ')}. `
      + `Search those dates first (explore_flights / explore_hotels), then revise again.` }
  }
  return { ok: true, refs, parentProposalId: parent.id }
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The same supplier, the same identity, the shifted dates — found in the
 * corpus or not at all. Flight identity is the flight-number list in order;
 * hotel identity is the name (the property token differs per search on some
 * suppliers, and the name is what she recognises). Newest row wins.
 */
async function findShifted(
  sql: postgres.Sql, conversationId: string, item: StoredItineraryItem, days: number,
): Promise<string | null> {
  if (item.detail.kind === 'flight') {
    const dep = shiftDate(item.detail.outbound.departureLocal.slice(0, 10), days)
    const rows = await sql<{ source_id: string; payload: { outbound: { departureLocal: string; flightNumbers: string[] } } }[]>`
      select source_id, payload from tool_results
       where conversation_id = ${conversationId} and supplier = ${item.supplier} and kind = 'flight'
         and payload->'outbound'->>'departureLocal' like ${dep + '%'}
       order by fetched_at desc, id desc`
    const want = item.detail.outbound.flightNumbers.join('+')
    const hit = rows.find((r) => r.payload.outbound.flightNumbers.join('+') === want)
    return hit ? hit.source_id : null
  }
  const checkIn = shiftDate(item.detail.checkIn, days), checkOut = shiftDate(item.detail.checkOut, days)
  const rows = await sql<{ source_id: string }[]>`
    select source_id from tool_results
     where conversation_id = ${conversationId} and supplier = ${item.supplier} and kind = 'hotel'
       and name = ${item.name} and payload->>'checkIn' = ${checkIn} and payload->>'checkOut' = ${checkOut}
     order by fetched_at desc, id desc limit 1`
  return rows[0]?.source_id ?? null
}
```

Note on the shift test: `MockSupplier` names hotels `hotel option N` and gives flight `i` the numbers `ZZ10i`, so item 0 of the shifted search matches item 0 of the original. That is what the test relies on; say so in a comment in the test.

Driver case:

```ts
    case 'revise_component': {
      const built = await buildRevisedRefs(sql, ctx.conversationId, input as ReviseInput)
      if (!built.ok) return `Revision refused: ${built.reason}`
      const round = await countPriorGateRuns(sql, ctx.turnId, callId)
      return runProposalPath(deps, ctx, spent, { refs: built.refs, notebook, round, parentProposalId: built.parentProposalId })
    }
```

Note `sanitizeSourceId` is imported for any id echoed in a refusal (none is echoed in the reasons above except via slot names, which come from a zod enum; keep the import out if unused, lint will say).

- [ ] **Step 5: Run, expect pass** — `pnpm vitest run test/revise.test.ts test/tools.test.ts` → PASS.

- [ ] **Step 6: Discrimination check** — in `countPriorGateRuns` drop `'revise_component'` from `GATE_RUN_TOOLS`; the "lands at round 1" test must fail with `round` 0 and the insert collision. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/tools/revise.ts src/tools/registry.ts src/gates/rehydrateGate.ts src/agents/driver.ts src/repo/toolCalls.ts test/revise.test.ts test/tools.test.ts
git commit -m "feat(tools): revise_component — one scoped change, full gates, new proposal row with lineage"
```

---

### Task 7: `bookingUrl` on the supplier port

**Files:**
- Modify: `src/supplier/types.ts` (`Supplier.bookingUrl`), `src/supplier/mock.ts`, `src/supplier/kiwi.ts`, `src/supplier/searchapi.ts`
- Create: `src/supplier/urls.ts` (shared checks)
- Create: `test/supplier-urls.test.ts`

**Interfaces:**
- Produces:

```ts
// src/supplier/types.ts
interface Supplier { ...; bookingUrl(item: SupplierItem, trackingRef: string): string }
// src/supplier/urls.ts
export const TRACKING_PARAM = 'gt_ref'
export class BookingUrlError extends Error {}
export function withTracking(raw: string, trackingRef: string, allow: (hostname: string) => boolean): string
export function isRegistrableHost(hostname: string): boolean
export const isKiwiHost: (h: string) => boolean          // 'kiwi.com' or '*.kiwi.com'
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/supplier-urls.test.ts
import { describe, expect, it } from 'vitest'
import { withTracking, isRegistrableHost, isKiwiHost, BookingUrlError, TRACKING_PARAM } from '../src/supplier/urls.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { KiwiSupplier } from '../src/supplier/kiwi.js'
import { SearchApiSupplier } from '../src/supplier/searchapi.js'
import { money } from '../src/money.js'
import type { SupplierItem } from '../src/supplier/types.js'

const item = (over: Partial<SupplierItem>): SupplierItem => ({
  sourceId: 'X', supplier: 'kiwi', kind: 'flight', name: 'n', price: money(1n, 'EUR'), priceBasis: 'total',
  fetchedAt: new Date(), ttlSeconds: 900, bookingUrl: null,
  detail: { kind: 'flight', outbound: { from: 'A', to: 'B', departureLocal: 'x', arrivalLocal: 'y', stops: 0, route: [], cabinClass: 'E', carriers: [], flightNumbers: [] }, inbound: null, baggage: { personalItem: 0, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 0, selfTransfer: false },
  ...over,
})

describe('withTracking', () => {
  it('appends the tracking ref as a query parameter and keeps the rest of the URL', () => {
    const out = withTracking('https://kiwi.com/u/abc?x=1', 'trk_1', isKiwiHost)
    const u = new URL(out)
    expect(u.hostname).toBe('kiwi.com'); expect(u.searchParams.get('x')).toBe('1')
    expect(u.searchParams.get(TRACKING_PARAM)).toBe('trk_1')
  })
  it('replaces an existing tracking parameter rather than doubling it', () => {
    const u = new URL(withTracking(`https://kiwi.com/u/abc?${TRACKING_PARAM}=old`, 'new', isKiwiHost))
    expect(u.searchParams.getAll(TRACKING_PARAM)).toEqual(['new'])
  })
  it.each(['http://kiwi.com/u/abc', 'https://user:pw@kiwi.com/u', 'https://evil.com/kiwi.com', 'https://kiwi.com.evil.com/u', 'javascript:alert(1)', 'not a url'])
    ('refuses %s', (raw) => { expect(() => withTracking(raw, 't', isKiwiHost)).toThrow(BookingUrlError) })
  it('accepts a kiwi subdomain', () => { expect(() => withTracking('https://www.kiwi.com/u/abc', 't', isKiwiHost)).not.toThrow() })
})

describe('isRegistrableHost', () => {
  it.each(['booking.com', 'www.pureformosa.com', 'domo-camp.org'])('accepts %s', (h) => expect(isRegistrableHost(h)).toBe(true))
  it.each(['localhost', '127.0.0.1', '[::1]', 'intranet', '10.0.0.1', ''])('refuses %s', (h) => expect(isRegistrableHost(h)).toBe(false))
})

describe('suppliers', () => {
  it('mock builds a URL on its own host carrying the ref', () => {
    const u = new URL(new MockSupplier({ kind: 'flight' }).bookingUrl(item({ supplier: 'mock' }), 'trk'))
    expect(u.hostname).toBe('mock.example'); expect(u.searchParams.get(TRACKING_PARAM)).toBe('trk')
  })
  it('kiwi uses the item\'s own deep link and refuses one off its domain', () => {
    const k = new KiwiSupplier()
    expect(new URL(k.bookingUrl(item({ bookingUrl: 'https://kiwi.com/u/4ym6t4q' }), 'trk')).searchParams.get(TRACKING_PARAM)).toBe('trk')
    expect(() => k.bookingUrl(item({ bookingUrl: 'https://example.com/u/1' }), 'trk')).toThrow(BookingUrlError)
    expect(() => k.bookingUrl(item({ bookingUrl: null }), 'trk')).toThrow(BookingUrlError)
  })
  it('searchapi accepts any https registrable host, since the link is the property\'s own site', () => {
    const s = new SearchApiSupplier('key')   // match the constructor the file already has
    const u = new URL(s.bookingUrl(item({ supplier: 'searchapi', kind: 'hotel', bookingUrl: 'https://www.booking.com/hotel/pt/x.html?aid=1' }), 'trk'))
    expect(u.hostname).toBe('www.booking.com'); expect(u.searchParams.get('aid')).toBe('1'); expect(u.searchParams.get(TRACKING_PARAM)).toBe('trk')
    expect(() => s.bookingUrl(item({ supplier: 'searchapi', bookingUrl: 'http://www.adaavo.pt/' }), 'trk')).toThrow(BookingUrlError)
    expect(() => s.bookingUrl(item({ supplier: 'searchapi', bookingUrl: 'https://localhost/x' }), 'trk')).toThrow(BookingUrlError)
  })
})
```

Check `SearchApiSupplier`'s constructor signature in `src/supplier/searchapi.ts` before writing the test and use it verbatim.

- [ ] **Step 2: Run, expect failure** — `pnpm vitest run test/supplier-urls.test.ts` → cannot resolve `../src/supplier/urls.js`.

- [ ] **Step 3: Implement**

```ts
// src/supplier/urls.ts
/**
 * Spec section 5, point 5: every URL she is handed is built server-side from a
 * supplier's own link, the final hostname is checked, and our tracking ref is
 * embedded so a conversion can be joined back to a click.
 *
 * The parameter name is ours to choose until an affiliate programme is joined;
 * when one is, the per-supplier adapter renames it in one place. Spec
 * deviation 2 (plan 3b): hotel links point at each property's own site, so
 * SearchApi's check is "a real https host", not a fixed allowlist.
 */
export const TRACKING_PARAM = 'gt_ref'

export class BookingUrlError extends Error {
  constructor(msg: string) { super(msg); this.name = 'BookingUrlError' }
}

export function isRegistrableHost(hostname: string): boolean {
  if (hostname.length === 0 || hostname === 'localhost') return false
  if (hostname.startsWith('[')) return false                       // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false        // IPv4 literal
  return hostname.includes('.')
}

export const isKiwiHost = (h: string): boolean => h === 'kiwi.com' || h.endsWith('.kiwi.com')

export function withTracking(raw: string, trackingRef: string, allow: (hostname: string) => boolean): string {
  let u: URL
  try { u = new URL(raw) } catch { throw new BookingUrlError(`not a URL: ${raw.slice(0, 80)}`) }
  if (u.protocol !== 'https:') throw new BookingUrlError(`refusing non-https link (${u.protocol})`)
  if (u.username !== '' || u.password !== '') throw new BookingUrlError('refusing link with credentials')
  if (!allow(u.hostname)) throw new BookingUrlError(`host not allowed: ${u.hostname}`)
  u.searchParams.delete(TRACKING_PARAM)
  u.searchParams.append(TRACKING_PARAM, trackingRef)
  return u.toString()
}
```

`Supplier` interface: add `bookingUrl(item: SupplierItem, trackingRef: string): string` with a doc comment pointing at `urls.ts`.

Mock: `bookingUrl(item, ref) { return withTracking(\`https://mock.example/book/${encodeURIComponent(item.sourceId)}\`, ref, (h) => h === 'mock.example') }`. Also change the mock's `build()` to set `bookingUrl` to that same `https://mock.example/book/…` string (it is `example.invalid` today; nothing reads it).

Kiwi: `bookingUrl(item, ref) { if (item.bookingUrl === null) throw new BookingUrlError('kiwi item carries no deep link'); return withTracking(item.bookingUrl, ref, isKiwiHost) }`.

SearchApi: same shape with `isRegistrableHost`.

- [ ] **Step 4: Run, expect pass** — `pnpm vitest run test/supplier-urls.test.ts` and `pnpm typecheck` (every `Supplier` implementation, including any test doubles in `test/`, must gain the method — grep `implements Supplier` and `: Supplier =`).

- [ ] **Step 5: Commit**

```bash
git add src/supplier test/supplier-urls.test.ts
git commit -m "feat(supplier): bookingUrl on the port — server-built, host-checked, tracking ref embedded"
```

---

### Task 8: The cashier — `hand_off_to_booking`

**Files:**
- Create: `src/tools/cashier.ts`
- Create: `src/repo/linkClicks.ts`
- Modify: `src/tools/registry.ts` (schema, `DESK_TOOLS`), `src/agents/driver.ts` (case), `test/tools.test.ts` (fixture)
- Create: `test/cashier.test.ts`

**Interfaces:**
- Consumes: `loadProposal`, `StoredItineraryItem`, `Supplier.quote`, `Supplier.bookingUrl`, `Supplier.capabilities`, `money`, `formatMoney`, `sanitizeSourceId`.
- Produces:

```ts
// src/tools/registry.ts
export const HandOff = z.strictObject({ proposalId: z.uuid() })
// src/repo/linkClicks.ts
export type LinkClickRow = { id: string; itemId: string; supplier: string; url: string; trackingRef: string; quotedMinor: bigint; currency: string }
export async function mintLinks(sql, args: { proposalId: string; turnId: string; userId: string;
  links: { itemId: string; supplier: string; buildUrl: (trackingRef: string) => string; quotedMinor: bigint; currency: string }[] }): Promise<LinkClickRow[]>
export async function linksForProposal(sql, proposalId: string): Promise<LinkClickRow[]>
// src/tools/cashier.ts
export const ACCEPT_WINDOW_MS = 30 * 60_000
export const TOLERANCE_BPS = 50n
export function withinTolerance(oldMinor: bigint, newMinor: bigint): boolean
export function sameIdentity(stored: StoredItineraryItem, fresh: SupplierItem): boolean
export type CashierDeps = { sql: postgres.Sql; flights: Supplier; hotels: Supplier; now: () => number }
export async function handOff(deps: CashierDeps, ctx: { conversationId: string; userId: string; turnId: string }, proposalId: string): Promise<string>
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/cashier.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { handOff, withinTolerance, sameIdentity, ACCEPT_WINDOW_MS } from '../src/tools/cashier.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { decideProposal } from '../src/repo/proposals.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier, type MockConfig } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const flight: FlightSearch = { kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false }
const hotel: HotelSearch = { kind: 'hotel', query: 'Faro beach', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2, currency: 'EUR' }
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const approve = () => ({ content: [{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r', usage })
const withBudget = (nb: Notebook): Notebook => ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

/** A proposal she can accept, built through the real path against the mock. */
async function seed(sql: postgres.Sql, n: string, mock: Partial<MockConfig> = {}) {
  const userId = `00000000-0000-4000-8000-000000000d${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'h' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const flights = new MockSupplier({ kind: 'flight', now: () => NOW, ...mock })
  const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW, ...mock })
  const fp = { ...flight, flexDays: Number(n) }, hp = { ...hotel, query: hotel.query + n }
  const fi = await flights.search(fp), hi = await hotels.search(hp)
  await recordResults(sql, { conversationId, userId, turnId, params: fp, items: fi })
  await recordResults(sql, { conversationId, userId, turnId, params: hp, items: hi })
  const path = { sql, transport: { create: vi.fn().mockResolvedValue(approve()) }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() }
  const ctx = { conversationId, userId, turnId }
  await runProposalPath(path, ctx, { micros: 0n }, { notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null,
    refs: [{ sourceId: fi[0]!.sourceId, quantity: 1, slot: 'outbound' }, { sourceId: hi[0]!.sourceId, quantity: 1, slot: 'stay' }] })
  const [p] = await sql`select id from proposals where conversation_id = ${conversationId}`
  const deps = { sql, flights, hotels, now: () => NOW.getTime() }
  return { ...ctx, deps, proposalId: p!.id as string, flights, hotels, fi, hi }
}
const accept = (sql: postgres.Sql, s: { proposalId: string; conversationId: string }, at = NOW) =>
  decideProposal(sql, { proposalId: s.proposalId, conversationId: s.conversationId, decision: 'accept', now: at })

describeDb('cashier', () => {
  it('refuses an unknown or foreign proposal', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '01'); const b = await seed(sql, '02')
      await accept(sql, a)
      expect(await handOff(b.deps, b, a.proposalId)).toMatch(/no proposal/i)
      expect(await sql`select 1 from link_clicks`).toHaveLength(0)
    })
  })
  it('refuses until she has accepted, and again after 30 minutes', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/not been accepted/i)
      await accept(sql, s, new Date(NOW.getTime() - ACCEPT_WINDOW_MS - 1000))
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/more than 30 minutes/i)
      expect(await sql`select 1 from link_clicks`).toHaveLength(0)
    })
  })
  it('refuses a rejected proposal', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      await decideProposal(sql, { proposalId: s.proposalId, conversationId: s.conversationId, decision: 'reject', now: NOW })
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/rejected/i)
    })
  })
  it('re-quotes every item, mints one link per item, and the reply carries URLs with the tracking ref', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await accept(sql, s)
      const qf = vi.spyOn(s.flights, 'quote'); const qh = vi.spyOn(s.hotels, 'quote')
      const out = await handOff(s.deps, s, s.proposalId)
      expect(qf).toHaveBeenCalledTimes(1); expect(qh).toHaveBeenCalledTimes(1)
      const links = await sql`select item_id, supplier, url, tracking_ref, quoted_minor, currency, turn_id from link_clicks where proposal_id = ${s.proposalId} order by item_id`
      expect(links).toHaveLength(2)
      for (const l of links) {
        expect(out).toContain(l.url as string)
        expect(new URL(l.url as string).searchParams.get('gt_ref')).toBe(l.tracking_ref)
        expect(l.turn_id).toBe(s.turnId)
      }
      expect(out).toMatch(/verified/i)
      const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(6_000n)   // the reviewer's call only; the cashier moved no money
    })
  })
  it.each([['unavailable'], ['gone'], ['throw']] as const)('blocks the whole hand-off when a quote is %s', async (mode) => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06', { quoteMode: mode })
      await accept(sql, s)
      const out = await handOff(s.deps, s, s.proposalId)
      expect(out).toMatch(/could not verify/i)
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(0)
    })
  })
  it('passes at exactly 0.5% and blocks one basis point over', () => {
    expect(withinTolerance(100_000n, 100_500n)).toBe(true)
    expect(withinTolerance(100_000n, 99_500n)).toBe(true)
    expect(withinTolerance(100_000n, 100_501n)).toBe(false)
    expect(withinTolerance(100_000n, 99_499n)).toBe(false)
  })
  it('blocks a price move past tolerance, naming the item and both prices', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07', { quoteDriftMinor: 5_000n })
      await accept(sql, s)
      const out = await handOff(s.deps, s, s.proposalId)
      expect(out).toMatch(/moved/i)
      expect(out).toContain(s.fi[0]!.sourceId)
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(0)
    })
  })
  it('blocks a CHEAPER fare whose identity changed', () => {
    const stored = { slot: 'outbound', quantity: 1, sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'n', priceMinor: '1000', currency: 'EUR', priceBasis: 'total' as const,
      fetchedAt: NOW.toISOString(), lineTotalMinor: '1000', searchParams: null,
      detail: { kind: 'flight' as const, outbound: { from: 'A', to: 'B', departureLocal: '2026-09-12T08:00:00', arrivalLocal: 'y', stops: 0, route: [], cabinClass: 'E', carriers: [], flightNumbers: ['ZZ100'] }, inbound: null, baggage: { personalItem: 0, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 0, selfTransfer: false } }
    const fresh = { sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'n', price: money(900n, 'EUR'), priceBasis: 'total' as const, fetchedAt: NOW, ttlSeconds: 900, bookingUrl: null,
      detail: { ...stored.detail, outbound: { ...stored.detail.outbound, flightNumbers: ['ZZ101'] } } }
    expect(sameIdentity(stored, fresh)).toBe(false)
    expect(sameIdentity(stored, { ...fresh, detail: stored.detail })).toBe(true)
  })
  it('blocks a same-price quote in a different currency', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '08')
      await accept(sql, s)
      vi.spyOn(s.flights, 'quote').mockImplementation(async (id, p) => {
        const r = await MockSupplier.prototype.quote.call(s.flights, id, p)
        return r.status === 'ok' ? { status: 'ok', item: { ...r.item, price: money(r.item.price.minor, 'USD') } } : r
      })
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/currency/i)
    })
  })
  it('discloses instead of verifying when the supplier cannot re-quote, and calls quote zero times', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '09', { mayRequote: false })
      await accept(sql, s)
      const qf = vi.spyOn(s.flights, 'quote')
      const out = await handOff(s.deps, s, s.proposalId)
      expect(qf).not.toHaveBeenCalled()
      expect(out).not.toMatch(/verified/i)
      expect(out).toMatch(/prices move/i)
      expect(out).toMatch(/min ago|minutes ago/i)
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(2)
    })
  })
  it('blocks an item with no stored search to re-run', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '10')
      await accept(sql, s)
      await sql`update proposals set itinerary = jsonb_set(itinerary, '{items,0,searchParams}', 'null') where id = ${s.proposalId}`
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/could not verify/i)
    })
  })
  it('returns the stored links on a second call and re-quotes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '11')
      await accept(sql, s)
      const first = await handOff(s.deps, s, s.proposalId)
      const qf = vi.spyOn(s.flights, 'quote')
      const second = await handOff(s.deps, s, s.proposalId)
      expect(qf).not.toHaveBeenCalled()
      expect(second).toBe(first)
    })
  })
  it('hands off a shipped_unapproved proposal but repeats the reviewer\'s issues', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '12')
      await sql`update proposals set gate_outcome = 'shipped_unapproved', review_issues = '["the stay is far from the beach"]' where id = ${s.proposalId}`
      await accept(sql, s)
      const out = await handOff(s.deps, s, s.proposalId)
      expect(out).toContain('the stay is far from the beach')
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(2)
    })
  })
})
```

- [ ] **Step 2: Run, expect failure** — `pnpm vitest run test/cashier.test.ts` → cannot resolve `../src/tools/cashier.js`.

- [ ] **Step 3: Implement the link repo**

```ts
// src/repo/linkClicks.ts
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'

export type LinkClickRow = {
  id: string; itemId: string; supplier: string; url: string; trackingRef: string
  quotedMinor: bigint; currency: string
}

/**
 * Spec section 5, point 5: mint `link_clicks.id` FIRST and embed it as the
 * tracking ref, store the exact emitted URL. One transaction for the whole
 * set: a partial set would let her book half a trip through tracked links and
 * half through nothing. `unique (proposal_id, item_id)` makes a second mint
 * for the same proposal a loud error rather than a duplicate.
 */
export async function mintLinks(
  sql: postgres.Sql,
  args: {
    proposalId: string; turnId: string; userId: string
    links: { itemId: string; supplier: string; buildUrl: (trackingRef: string) => string; quotedMinor: bigint; currency: string }[]
  },
): Promise<LinkClickRow[]> {
  const rows = args.links.map((l) => {
    const id = randomUUID()
    const trackingRef = `gt_${id.replace(/-/g, '')}`
    return { id, proposal_id: args.proposalId, turn_id: args.turnId, user_id: args.userId,
      item_id: l.itemId, supplier: l.supplier, url: l.buildUrl(trackingRef), tracking_ref: trackingRef,
      quoted_minor: l.quotedMinor.toString(), currency: l.currency }
  })
  await sql.begin(async (tx) => { await tx`insert into link_clicks ${tx(rows)}` })
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, supplier: r.supplier, url: r.url,
    trackingRef: r.tracking_ref, quotedMinor: BigInt(r.quoted_minor), currency: r.currency }))
}

export async function linksForProposal(sql: postgres.Sql, proposalId: string): Promise<LinkClickRow[]> {
  const rows = await sql<{ id: string; item_id: string; supplier: string; url: string; tracking_ref: string; quoted_minor: string; currency: string }[]>`
    select id, item_id, supplier, url, tracking_ref, quoted_minor, currency
      from link_clicks where proposal_id = ${proposalId} order by rendered_at, item_id`
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, supplier: r.supplier, url: r.url,
    trackingRef: r.tracking_ref, quotedMinor: BigInt(r.quoted_minor), currency: r.currency }))
}
```

- [ ] **Step 4: Implement the cashier**

```ts
// src/tools/cashier.ts
import type postgres from 'postgres'
import { loadProposal, type ProposalRow, type StoredItineraryItem } from '../repo/proposals.js'
import { linksForProposal, mintLinks, type LinkClickRow } from '../repo/linkClicks.js'
import { formatMoney, money } from '../money.js'
import { sanitizeSourceId } from '../sanitize.js'
import { BookingUrlError } from '../supplier/urls.js'
import type { Supplier, SupplierItem } from '../supplier/types.js'

/** Spec section 5, point 1. One definition; the plan 4 UI reads it too. */
export const ACCEPT_WINDOW_MS = 30 * 60_000
/** ±0.5% in basis points. Integer arithmetic only. */
export const TOLERANCE_BPS = 50n

export type CashierDeps = { sql: postgres.Sql; flights: Supplier; hotels: Supplier; now: () => number }

/** |new − old| × 10 000 ≤ old × 50, so "exactly 0.5%" passes and one bp over does not. */
export function withinTolerance(oldMinor: bigint, newMinor: bigint): boolean {
  const diff = newMinor > oldMinor ? newMinor - oldMinor : oldMinor - newMinor
  return diff * 10_000n <= oldMinor * TOLERANCE_BPS
}

/**
 * Spec section 5, point 3: "per item and on item identity, not just on the
 * sum. A total that fell because a refundable fare became basic economy is a
 * downgrade she never accepted." Flight identity: supplier, id, and the
 * flight-number lists in order, both directions. Hotel identity: supplier, id,
 * name, check-in and check-out.
 */
export function sameIdentity(stored: StoredItineraryItem, fresh: SupplierItem): boolean {
  if (stored.supplier !== fresh.supplier || stored.sourceId !== fresh.sourceId || stored.kind !== fresh.kind) return false
  const a = stored.detail, b = fresh.detail
  if (a.kind === 'flight' && b.kind === 'flight') {
    const legs = (x: typeof a) => [x.outbound.flightNumbers.join('+'), x.inbound ? x.inbound.flightNumbers.join('+') : '',
      x.outbound.departureLocal.slice(0, 10), x.inbound ? x.inbound.departureLocal.slice(0, 10) : ''].join('|')
    return legs(a) === legs(b)
  }
  if (a.kind === 'hotel' && b.kind === 'hotel') {
    return stored.name === fresh.name && a.checkIn === b.checkIn && a.checkOut === b.checkOut
  }
  return false
}

type Refusal = { ok: false; text: string }
type Verified = { ok: true; fresh: Map<string, SupplierItem> }

/**
 * The cashier. Takes a proposal id and nothing else. Every refusal is text the
 * model can pass on; every success ends in tracked links.
 *
 * Idempotent through `link_clicks`: if links already exist for this proposal
 * the stored set is returned and no supplier is called. The worker's
 * `tool_calls` pending row (src/worker.ts) is the other half — a resumed turn
 * that died mid-mint reports `ambiguous` and the turn fails as `fenced` rather
 * than minting twice. Plan 3b deviation 1 records why the mint and the
 * tool_calls finish are not one transaction.
 *
 * Moves no money. Writes no spend.
 */
export async function handOff(
  deps: CashierDeps, ctx: { conversationId: string; userId: string; turnId: string }, proposalId: string,
): Promise<string> {
  const { sql } = deps
  const now = new Date(deps.now())
  const p = await loadProposal(sql, ctx.conversationId, proposalId)
  if (p === null) return `No proposal ${sanitizeSourceId(proposalId)} in this conversation.`

  const existing = await linksForProposal(sql, p.id)
  if (existing.length > 0) return render(p, existing, now, verifiedLabel(deps, p))

  if (p.decision === 'reject') return 'She rejected this proposal. Ask what to change, or propose another.'
  if (p.decision !== 'accept' || p.decidedAt === null) {
    return 'This proposal has not been accepted. Hand-off happens only after she accepts in chat; do not ask her to say it to you — the card has the button.'
  }
  if (now.getTime() - p.decidedAt.getTime() > ACCEPT_WINDOW_MS) {
    return 'She accepted this more than 30 minutes ago; prices may have moved. Ask her to accept again on a fresh proposal.'
  }
  if (p.itinerary.schemaVersion !== 1) return 'This proposal was saved in a shape the cashier cannot read.'

  const verify = await requote(deps, p, now)
  if (!verify.ok) return verify.text

  const links = await mintLinks(sql, {
    proposalId: p.id, turnId: ctx.turnId, userId: ctx.userId,
    links: p.itinerary.items.map((i) => {
      const fresh = verify.fresh.get(i.sourceId)
      const quoted = fresh ? fresh.price.minor : BigInt(i.priceMinor)
      const sup = supplierFor(deps, i)
      const item: SupplierItem = fresh ?? storedAsItem(i)
      return { itemId: i.sourceId, supplier: i.supplier, quotedMinor: quoted, currency: i.currency,
        buildUrl: (ref: string) => sup.bookingUrl(item, ref) }
    }),
  }).catch((err: unknown) => { if (err instanceof BookingUrlError) return err; throw err })
  if (links instanceof BookingUrlError) return `Could not build a booking link: ${links.message}. Escalate to a human.`
  return render(p, links, now, verifiedLabel(deps, p))
}

function supplierFor(deps: CashierDeps, i: StoredItineraryItem): Supplier {
  return i.kind === 'flight' ? deps.flights : deps.hotels
}

function verifiedLabel(deps: CashierDeps, p: ProposalRow): boolean {
  return p.itinerary.items.every((i) => supplierFor(deps, i).capabilities.mayRequote)
}

async function requote(deps: CashierDeps, p: ProposalRow, now: Date): Promise<Verified | Refusal> {
  const fresh = new Map<string, SupplierItem>()
  const block = (i: StoredItineraryItem, why: string): Refusal =>
    ({ ok: false, text: `Could not verify ${sanitizeSourceId(i.sourceId)} (${i.slot}): ${why}. Nothing was handed off. Re-search that slot and propose again, or escalate.` })
  for (const i of p.itinerary.items) {
    const sup = supplierFor(deps, i)
    if (sup.name !== i.supplier) return block(i, `this desk has no supplier named ${i.supplier}`)
    if (!sup.capabilities.mayRequote) continue                    // disclosure path; nothing to verify
    if (i.searchParams === null) return block(i, 'no stored search to re-run')
    let q
    try { q = await sup.quote(i.sourceId, i.searchParams) } catch (err) { return block(i, `the supplier failed (${(err as Error).message})`) }
    if (q.status === 'gone') return block(i, 'it is no longer offered')
    if (q.status === 'unavailable') return block(i, q.reason)
    const item = q.item
    if (item.price.currency !== i.currency) return block(i, `it is now quoted in ${item.price.currency}, not ${i.currency}`)
    if (!sameIdentity(i, item)) return block(i, 'the offer changed (different flights or dates) even though the id matched')
    if (now.getTime() - item.fetchedAt.getTime() > item.ttlSeconds * 1000) return block(i, 'the re-quote came back already stale')
    const old = BigInt(i.priceMinor)
    if (!withinTolerance(old, item.price.minor)) {
      return { ok: false, text: `The price of ${sanitizeSourceId(i.sourceId)} (${i.slot}) moved from ${formatMoney(money(old, i.currency))} `
        + `to ${formatMoney(item.price)}, outside the ±0.5% we allow. Nothing was handed off. Tell her, then re-search and propose again if she wants to continue.` }
    }
    fresh.set(i.sourceId, item)
  }
  return { ok: true, fresh }
}

function storedAsItem(i: StoredItineraryItem): SupplierItem {
  return { sourceId: i.sourceId, supplier: i.supplier, kind: i.kind, name: i.name, price: money(BigInt(i.priceMinor), i.currency),
    priceBasis: i.priceBasis, fetchedAt: new Date(i.fetchedAt), ttlSeconds: 0, bookingUrl: null, detail: i.detail }
}

/**
 * What the model passes on. Spec section 5, point 4: when nothing was
 * re-quoted the copy is DISCLOSURE, never verification, and every price
 * renders with its age.
 */
function render(p: ProposalRow, links: LinkClickRow[], now: Date, verified: boolean): string {
  const byId = new Map(p.itinerary.items.map((i) => [i.sourceId, i]))
  const lines = links.map((l) => {
    const i = byId.get(l.itemId)
    const ageMin = i ? Math.max(0, Math.round((now.getTime() - new Date(i.fetchedAt).getTime()) / 60_000)) : 0
    const price = formatMoney(money(l.quotedMinor, l.currency))
    return `- ${i?.slot ?? l.itemId}: ${i?.name ?? ''} — ${price}${verified ? '' : ` (found ${ageMin} min ago)`} — ${l.url}`
  })
  const head = verified
    ? 'Verified just now against the suppliers; every item is still offered at the price she accepted (within 0.5%).'
    : `These were the prices when we found them. Prices move; tell her to check the total before she pays.`
  const warn = p.gateOutcome === 'shipped_unapproved' && p.reviewIssues.length > 0
    ? `\n\nThe reviewer did not approve this offer: ${p.reviewIssues.join('; ')}. Say so plainly before the links.` : ''
  return `${head}${warn}\n\nGive her these links, one per line, exactly as written:\n${lines.join('\n')}\n\nThis is the point of no return: do not re-quote, revise, or re-propose this set.`
}
```

Registry: add `HandOff` schema and

```ts
  hand_off_to_booking: { name: 'hand_off_to_booking', door: 'code', schema: HandOff,
    description: 'After she has ACCEPTED a proposal in chat, hand her tracked booking links. Takes the proposal_id only. Refuses if she has not accepted, or accepted more than 30 minutes ago.' },
```

`DESK_TOOLS.planning` gains `'hand_off_to_booking'`; fixture `hand_off_to_booking: { proposalId: '00000000-0000-4000-8000-000000000001' }`.

Driver case:

```ts
    case 'hand_off_to_booking': {
      const { proposalId } = input as { proposalId: string }
      return handOff({ sql, flights: deps.flights, hotels: deps.hotels, now: deps.now }, ctx, proposalId)
    }
```

- [ ] **Step 5: Run, expect pass** — `pnpm vitest run test/cashier.test.ts test/tools.test.ts` → PASS, 14 tests.

- [ ] **Step 6: Discrimination check** — change `withinTolerance` to `<` ; the boundary test fails. Restore. Make `sameIdentity` return `true`; the identity test fails. Restore. Remove the `linksForProposal` early return; the replay test fails (quote called). Restore.

- [ ] **Step 7: Commit**

```bash
git add src/tools/cashier.ts src/repo/linkClicks.ts src/tools/registry.ts src/agents/driver.ts test/cashier.test.ts test/tools.test.ts
git commit -m "feat(cashier): hand_off_to_booking — accept window, per-item re-quote, tracked links, disclosure when unverifiable"
```

---

### Task 9: `escalate_to_human` and the Notifier port

**Files:**
- Create: `src/notify.ts`, `src/repo/escalations.ts`, `src/tools/escalate.ts`
- Modify: `src/tools/registry.ts`, `src/agents/driver.ts` (`DriverDeps.notifier`, case), `test/tools.test.ts` (fixture), `test/driver.test.ts` (`deps()` helper gains `notifier: new LogNotifier()`)
- Create: `test/escalate.test.ts`

**Interfaces:**
- Produces:

```ts
// src/notify.ts
export type Escalation = { id: string; conversationId: string; userId: string; turnId: string | null; proposalId: string | null; reason: EscalationReason; createdAt: Date }
export type EscalationReason = 'supplier_unavailable' | 'price_moved' | 'user_request' | 'safety' | 'cannot_satisfy'
export const ESCALATION_REASONS: readonly EscalationReason[]
export interface Notifier { notify(e: Escalation): Promise<void> }
export class LogNotifier implements Notifier { constructor(log?: (line: string) => void) }
// src/repo/escalations.ts
export const MAX_ESCALATIONS_PER_DAY = 3
export async function countEscalationsToday(sql, userId: string, now: Date): Promise<number>
export async function recordEscalation(sql, args: { conversationId; userId; turnId; proposalId: string | null; reason: EscalationReason }): Promise<Escalation>   // also sets conversations.status = 'escalated', in one transaction
export async function markNotified(sql, escalationId: string): Promise<void>
// src/tools/escalate.ts
export async function escalate(deps: { sql; notifier: Notifier; now: () => number }, ctx, input: { reason: EscalationReason; proposalId?: string }): Promise<string>
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/escalate.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { escalate } from '../src/tools/escalate.js'
import { LogNotifier, type Notifier } from '../src/notify.js'
import { MAX_ESCALATIONS_PER_DAY } from '../src/repo/escalations.js'

const NOW = new Date('2026-09-13T12:00:00Z')
async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000e${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'e' + n}, 'running') returning id`
  return { userId, conversationId: c!.id as string, turnId: t!.id as string }
}
const deps = (sql: postgres.Sql, notifier: Notifier = new LogNotifier(() => {})) => ({ sql, notifier, now: () => NOW.getTime() })

describeDb('escalate_to_human', () => {
  it('writes the row, marks the conversation escalated, notifies, and stamps notified_at', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const notify = vi.fn().mockResolvedValue(undefined)
      const out = await escalate(deps(sql, { notify }), s, { reason: 'price_moved' })
      expect(out).toMatch(/escalated/i)
      const [e] = await sql`select reason, notified_at, turn_id from escalations where conversation_id = ${s.conversationId}`
      expect(e!.reason).toBe('price_moved'); expect(e!.notified_at).not.toBeNull(); expect(e!.turn_id).toBe(s.turnId)
      const [c] = await sql`select status from conversations where id = ${s.conversationId}`
      expect(c!.status).toBe('escalated')
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: 'price_moved', conversationId: s.conversationId }))
    })
  })
  it('keeps the row and the status when the notifier throws; notified_at stays null', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const out = await escalate(deps(sql, { notify: vi.fn().mockRejectedValue(new Error('smtp down')) }), s, { reason: 'safety' })
      expect(out).toMatch(/escalated/i)
      const [e] = await sql`select notified_at from escalations where conversation_id = ${s.conversationId}`
      expect(e!.notified_at).toBeNull()
      const [c] = await sql`select status from conversations where id = ${s.conversationId}`
      expect(c!.status).toBe('escalated')
    })
  })
  it('refuses the fourth escalation in a UTC day, and allows it the next day', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      for (let i = 0; i < MAX_ESCALATIONS_PER_DAY; i++) {
        await sql`insert into escalations (conversation_id, user_id, reason, created_at) values (${s.conversationId}, ${s.userId}, 'user_request', ${new Date(NOW.getTime() - i * 60_000)})`
      }
      const notify = vi.fn()
      const out = await escalate(deps(sql, { notify }), s, { reason: 'user_request' })
      expect(out).toMatch(/limit/i); expect(notify).not.toHaveBeenCalled()
      expect(await sql`select 1 from escalations where conversation_id = ${s.conversationId}`).toHaveLength(MAX_ESCALATIONS_PER_DAY)
      const tomorrow = { ...deps(sql, { notify: vi.fn().mockResolvedValue(undefined) }), now: () => NOW.getTime() + 86_400_000 }
      expect(await escalate(tomorrow, s, { reason: 'user_request' })).toMatch(/escalated/i)
    })
  })
  it('refuses a proposal id from another conversation and records nothing', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '04'); const b = await seed(sql, '05')
      const [p] = await sql`insert into proposals (conversation_id, user_id, itinerary, requirements_snapshot, total_minor, currency, gate_outcome)
        values (${a.conversationId}, ${a.userId}, '{"schemaVersion":1,"items":[]}', '{}', 0, 'EUR', 'approved') returning id`
      const out = await escalate(deps(sql), b, { reason: 'price_moved', proposalId: p!.id as string })
      expect(out).toMatch(/no proposal/i)
      expect(await sql`select 1 from escalations where conversation_id = ${b.conversationId}`).toHaveLength(0)
    })
  })
  it('the LogNotifier writes one line naming the reason and the conversation', async () => {
    const lines: string[] = []
    await new LogNotifier((l) => lines.push(l)).notify({ id: 'x', conversationId: 'c1', userId: 'u', turnId: null, proposalId: null, reason: 'safety', createdAt: NOW })
    expect(lines).toHaveLength(1); expect(lines[0]).toContain('safety'); expect(lines[0]).toContain('c1')
  })
})
```

- [ ] **Step 2: Run, expect failure** — `pnpm vitest run test/escalate.test.ts` → cannot resolve modules.

- [ ] **Step 3: Implement**

```ts
// src/notify.ts
export type EscalationReason = 'supplier_unavailable' | 'price_moved' | 'user_request' | 'safety' | 'cannot_satisfy'
export const ESCALATION_REASONS: readonly EscalationReason[] =
  ['supplier_unavailable', 'price_moved', 'user_request', 'safety', 'cannot_satisfy']
export type Escalation = {
  id: string; conversationId: string; userId: string; turnId: string | null
  proposalId: string | null; reason: EscalationReason; createdAt: Date
}
/**
 * The human desk's inbox, as a port. Spec section 3 says email; nothing is
 * deployed and no provider is configured, so the only implementation logs.
 * A real adapter is one file and no change to callers (plan 3b ruling).
 * Implementations must never throw on a malformed escalation — the row is
 * already committed by the time this runs, and the caller swallows anyway.
 */
export interface Notifier { notify(e: Escalation): Promise<void> }
export class LogNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void = (l) => console.error(l)) {}
  async notify(e: Escalation): Promise<void> {
    this.log(`ESCALATION ${e.id} reason=${e.reason} conversation=${e.conversationId} proposal=${e.proposalId ?? '-'} at=${e.createdAt.toISOString()}`)
  }
}
```

```ts
// src/repo/escalations.ts
import type postgres from 'postgres'
import type { Escalation, EscalationReason } from '../notify.js'

/** Spec section 4: rate-limited per user per day. Three is enough for a human to notice a pattern and few enough to stop a loop. */
export const MAX_ESCALATIONS_PER_DAY = 3

/** UTC day, like daily_usage. Throws on a missing row: a failed count is a refusal, not zero. */
export async function countEscalationsToday(sql: postgres.Sql, userId: string, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from escalations
     where user_id = ${userId} and created_at >= ${day + 'T00:00:00Z'}::timestamptz and created_at < (${day + 'T00:00:00Z'}::timestamptz + interval '1 day')`
  const row = rows[0]
  if (!row) throw new Error('countEscalationsToday: no row; refusing to assume zero')
  return row.n
}

/** The row and the status flip commit together; the notifier runs after, outside. */
export async function recordEscalation(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; turnId: string | null; proposalId: string | null; reason: EscalationReason },
): Promise<Escalation> {
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string; created_at: Date }[]>`
      insert into escalations (conversation_id, user_id, turn_id, proposal_id, reason)
      values (${args.conversationId}, ${args.userId}, ${args.turnId}, ${args.proposalId}, ${args.reason})
      returning id, created_at`
    await tx`update conversations set status = 'escalated', updated_at = now()
              where id = ${args.conversationId} and user_id = ${args.userId}`
    return { id: e!.id, conversationId: args.conversationId, userId: args.userId, turnId: args.turnId,
      proposalId: args.proposalId, reason: args.reason, createdAt: e!.created_at }
  }) as Promise<Escalation>
}

export async function markNotified(sql: postgres.Sql, escalationId: string): Promise<void> {
  await sql`update escalations set notified_at = now() where id = ${escalationId} and notified_at is null`
}
```

```ts
// src/tools/escalate.ts
import type postgres from 'postgres'
import type { EscalationReason, Notifier } from '../notify.js'
import { MAX_ESCALATIONS_PER_DAY, countEscalationsToday, markNotified, recordEscalation } from '../repo/escalations.js'
import { loadProposal } from '../repo/proposals.js'
import { sanitizeSourceId } from '../sanitize.js'

/**
 * Fixed format in, one row out. The model chooses a reason from an enum and
 * optionally names a proposal; no free text reaches the row. The rate limit
 * is read fail-closed from the table. The notifier is best-effort and
 * swallowed, exactly like a span: the escalation exists once the row does.
 */
export async function escalate(
  deps: { sql: postgres.Sql; notifier: Notifier; now: () => number },
  ctx: { conversationId: string; userId: string; turnId: string },
  input: { reason: EscalationReason; proposalId?: string },
): Promise<string> {
  const now = new Date(deps.now())
  if (input.proposalId !== undefined && (await loadProposal(deps.sql, ctx.conversationId, input.proposalId)) === null) {
    return `No proposal ${sanitizeSourceId(input.proposalId)} in this conversation; escalate without a proposal id or use the right one.`
  }
  const used = await countEscalationsToday(deps.sql, ctx.userId, now)
  if (used >= MAX_ESCALATIONS_PER_DAY) {
    return `Escalation limit reached for today (${MAX_ESCALATIONS_PER_DAY}). Tell her a human will not be paged again today and offer what you can do yourself.`
  }
  const e = await recordEscalation(deps.sql, { conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId,
    proposalId: input.proposalId ?? null, reason: input.reason })
  try {
    await deps.notifier.notify(e)
    await markNotified(deps.sql, e.id)
  } catch (err) {
    console.error(`escalate: notifier failed for ${e.id}: ${(err as Error).message}`)
  }
  return `Escalated to a human (reason: ${input.reason}). Tell her someone will look at this and stop planning; do not promise a time.`
}
```

Registry schema and entry:

```ts
export const EscalateToHuman = z.strictObject({
  reason: z.enum(ESCALATION_REASONS as [EscalationReason, ...EscalationReason[]]),
  proposalId: z.uuid().optional(),
})
  escalate_to_human: { name: 'escalate_to_human', door: 'code', schema: EscalateToHuman,
    description: 'Hand this conversation to a human. reason is one of the fixed codes; add proposalId when it concerns a saved proposal. Use when a supplier is down, a price moved past what she accepted, she asks for a person, or you cannot satisfy a constraint.' },
```

`DESK_TOOLS.planning` gains `'escalate_to_human'`; fixture `escalate_to_human: { reason: 'user_request' }`. `DriverDeps` gains `notifier: Notifier`; driver case:

```ts
    case 'escalate_to_human':
      return escalate({ sql, notifier: deps.notifier, now: deps.now }, ctx, input as { reason: EscalationReason; proposalId?: string })
```

Every `makeDriver` call site (`test/driver.test.ts` `deps()`, `scripts/demo.ts`, and `netlify/functions/*` if any constructs it) passes `notifier: new LogNotifier()`. Grep `makeDriver(` to find them all.

- [ ] **Step 4: Run, expect pass** — `pnpm vitest run test/escalate.test.ts test/tools.test.ts test/driver.test.ts` → PASS.

- [ ] **Step 5: Discrimination check** — change `used >= MAX` to `>`; the fourth-call test fails. Restore. Move `markNotified` before `notify`; the throwing-notifier test fails on `notified_at`. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/notify.ts src/repo/escalations.ts src/tools/escalate.ts src/tools/registry.ts src/agents/driver.ts test/escalate.test.ts test/tools.test.ts test/driver.test.ts scripts/demo.ts
git commit -m "feat(tools): escalate_to_human — fixed reasons, daily limit, Notifier port with a logging adapter"
```

---

### Task 10: The prompt at version 2, and the desk's tool list pinned

**Files:**
- Modify: `src/agents/prompts/driver.md`, `src/model/seats.ts` (`driver@2`), `test/tools.test.ts` (desk list), `test/model-seats.test.ts` if it pins the version string, `test/driver.test.ts` (`prompt_version` assertion → `driver@2`)

- [ ] **Step 1: Update the pinned list test** in `test/tools.test.ts` (`exposes exactly the planning desk tools this plan implements`) to the eight names: `update_requirements, ask_user, explore_flights, explore_hotels, propose_itinerary, revise_component, hand_off_to_booking, escalate_to_human`. Run: FAIL if any earlier task forgot `DESK_TOOLS`; otherwise PASS. Either way, this is the pin.

- [ ] **Step 2: Bump the seat** — `driver: seat(OPUS, 'high', 16_000, 'driver@2')`. Fix the `prompt_version` assertion in `test/driver.test.ts`.

- [ ] **Step 3: Append to `driver.md`** after the "If a proposal comes back rejected" paragraph:

```md
## After a proposal is saved

A saved proposal has a `proposal_id`. The office shows it to her as a card with
Accept, per-component change, and Reject. You do not ask her to type "accept".

If she wants one thing changed — a different hotel, a different flight, dates a
few days later — call `revise_component` with the `proposal_id` and exactly one
change. A shift only works for dates you have already searched; search first if
you have not. The office runs every gate and the reviewer again and saves a new
proposal with its own id. Refer to the newest one from then on.

If the reviewer did not approve an offer, say so in her words before anything
else. She decides; you do not hide it.

## Handing off

Only after she has accepted, call `hand_off_to_booking` with the `proposal_id`.
The office re-checks every price with the supplier and gives you tracked links.
Pass the links on exactly as written, one per line. If the office refuses —
she has not accepted, the acceptance is stale, a price moved — tell her what it
said and offer to re-search. Never build or guess a booking link yourself.

## When to escalate

`escalate_to_human` reaches a person. Use it when a supplier is down, when a
price moved past what she accepted and she wants help, when she asks for a
person, or when you cannot satisfy something she stated. Pick the reason code;
there is no free text. It is limited per day, and after it fires you stop
planning and tell her someone will look.
```

- [ ] **Step 4: Run everything** — `pnpm test && pnpm typecheck && pnpm lint` → green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompts/driver.md src/model/seats.ts test/tools.test.ts test/driver.test.ts test/model-seats.test.ts
git commit -m "feat(driver): prompt driver@2 — revise, hand-off, escalate; planning desk carries eight tools"
```

---

### Task 11: The demo shows the cashier

**Files:**
- Modify: `scripts/demo.ts`

- [ ] **Step 1: Add a scenario** `cashierScenario` after the existing gate scenario and before `liveDriverScenario`, run without `LIVE_MODEL`: seed a conversation and a running turn for the demo user; search flights and hotels through two `MockSupplier`s and `recordResults`; call `runProposalPath` with a transport stub that returns an approving verdict; print the proposal row; call `decideProposal(... 'accept')`; call `handOff` and print the `link_clicks` rows; then call `handOff` again and show `quote` was not called (wrap the mock's `quote` to count). Then re-run with `new MockSupplier({ kind: 'flight', quoteDriftMinor: 9_000n })` on a second proposal and print the refusal text. Follow the file's existing print helpers and cleanup pattern (everything under the fixed demo user id, deleted at both ends).

- [ ] **Step 2: Run** — `pnpm demo` (no `LIVE_MODEL`) → the new scenario prints two link rows, a replay with zero quotes, and one price-moved refusal. Paste the output into the commit body.

- [ ] **Step 3: Commit** — `git commit -am "docs(demo): cashier scenario — accept, re-quote, tracked links, replay, price moved"`.

---

### Task 12: Records — decisions, backlog, work log

**Files:**
- Create: `docs/superpowers/2026-09-13-plan-3b-gates-decisions.md`
- Modify: `docs/backlog-plan.md`, `docs/work-log.md`, `docs/superpowers/specs/2026-09-13-plan-3b-gates-design.md`

- [ ] **Step 1: Decisions doc**, same format as `2026-08-29-model-client-and-driver-decisions.md`: the four deviations from the plan header plus every ruling an implementer took on the author's behalf during execution, each with *what*, *why*, *cost if wrong*.

- [ ] **Step 2: Spec corrections** — in `2026-09-13-plan-3b-gates-design.md` §6, replace the "Minting is the point of no return" paragraph's transaction sentence and the hotel-URL sentence in "URLs" with what was built (deviations 1 and 2), citing this plan.

- [ ] **Step 3: Backlog** — add rows for: no reaper for `link_clicks`/`escalations` (retention unspecified); `Notifier` has no real transport; the affiliate parameter name `gt_ref` is a placeholder until a programme is joined; the `spent` accumulator is lost on a crashed attempt, same as `recordedMicros` (pre-existing, now named); plan 3c items (front desk, scouts, drift monitor, CI, `trimForContext` price half).

- [ ] **Step 4: Work log** — new "What the last session did" (the six modules, test count), state table row for 3b → Merged, 3c → next, and a *Careful* entry: `hand_off_to_booking` is idempotent through `link_clicks` and the `tool_calls` pending row, not through one transaction, so a crash between mint and finish fails the turn `fenced` with links already in the table.

- [ ] **Step 5: Commit** — `git commit -am "docs: plan 3b decisions, backlog, work log"`.

---

## Self-review

**Spec coverage.** §0 finding → Task 2 and 5. §2 save → Task 2, 5. §3 reviewer (seat, schema, refusal, rounds from `gate_results`, `TurnState.reviewRounds` removed, gate-pass-first) → Tasks 3, 4, 5. §4 revision (swap, shift from corpus, no supplier call, lineage, `countPriorGateRuns`, collision test) → Task 6. §5 `decideProposal` → Task 2, used in Tasks 8 and 11. §6 cashier (seven checks, tolerance in bps, identity, disclosure, server URLs, tracking ref, replay, no money) → Tasks 7, 8. §7 escalation (enum, table, limit, Notifier, status, best-effort notify, idempotent via `tool_calls`) → Tasks 1, 9. §8 prompt `driver@2` and `DESK_TOOLS` → Task 10. §9 testing → every task's discrimination step; request-surface live pin → Task 3; money assertions → Tasks 4, 5, 8. §10 rulings → Task 12 records them. Gaps: none found. Two spec sentences are corrected by Task 12 (deviations 1, 2).

**Placeholders.** Task 5 step 6 and Task 11 step 1 describe a test and a scenario in prose rather than full code; both name the exact assertions and the harness to copy from, which is the file's own established pattern. Task 7 tells the implementer to read `SearchApiSupplier`'s constructor rather than guessing it.

**Type consistency.** `runProposalPath(deps, ctx, spent, args)` in Tasks 5, 6, 8, 11. `countPriorGateRuns(sql, turnId, callId)` in Tasks 6, 8. `handOff(deps, ctx, proposalId)` in Tasks 8, 11. `StoredItineraryItem.searchParams: SearchParams | null` (Task 2) is what Task 8's `requote` reads. `ReviewDeps = { sql, transport, limits, now }` (Task 4) is `ProposalPathDeps` (Task 5), satisfied by `DriverDeps`. `Supplier.bookingUrl(item, trackingRef)` (Task 7) is what Task 8's `mintLinks` callback calls. `LinkClickRow.quotedMinor: bigint` in Task 8 only.
