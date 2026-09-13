# Plan 3c — Seats Half Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the front desk and the scouts, tell the driver which results have expired, stand up the drift monitor, and give the repo its first CI pipeline.

**Architecture:** The front desk is a second `Agent` the worker reaches through a router keyed on `conversations.desk`; a new `continue` step lets one turn flow from front desk to driver. Scouts are a worker-door tool that makes one Haiku call with the API's server-side web search, redacted and fenced on the way back. The drift monitor is a pure function over a transport and the database, scheduled by a Netlify function. CI is a GitHub Actions workflow against a Postgres service container with the migrations applied from zero.

**Tech Stack:** TypeScript (NodeNext ESM), postgres.js, zod 4, `@anthropic-ai/sdk` 0.122 (transport-injected), vitest, GitHub Actions, Netlify scheduled functions.

**Spec:** `docs/superpowers/specs/2026-09-13-plan-3c-seats-design.md`, narrowing `docs/superpowers/specs/2026-08-15-globetrotty-design.md` §3, §4, §7, §8, §11 (binding).

## Global Constraints

- Money is `bigint` micros; only `recordSpend`, `reserve`, `reconcile` move it. Every model call: `reserve` → ceiling check on the returned values via `firstCeilingReached` → `callModel` → `reconcile` → `recordModelCall` (best-effort). Self-debited spend travels as `recordedMicros` (agent steps) or `spent.micros` (tool runs), never to `recordSpend`.
- Prompt versions: `front_desk@1`, `scout@1`, `driver@2` (unchanged). Seats and `capturePolicyFor` are unchanged.
- Everything a model or a supplier wrote that reaches a model prompt or a stored tool result passes `maskUntrustedText` (strings) and, for worker/api doors, `fenceResult`.
- One `gate_results` row per `(turn_id, round, gate)`; nothing in this plan runs the gates.
- No new required environment variable. `src/env.ts` `KEYS` is unchanged.
- Never edit migrations 0001–0014. New DDL is `0015_plan_3c_seats.sql`.
- Every rule gets the break-and-watch-it-fail check; the plan names the break per test.
- Commit after every task; messages end with the session's attribution lines. `pnpm test && pnpm typecheck && pnpm lint` clean before every commit.
- Web search: `WEB_SEARCH_MICROS = 10_000n` per request ($10 per 1 000). Tool type `web_search_20260209`, name `web_search`, `max_uses: 3`. Usage field `usage.server_tool_use.web_search_requests`.
- `OPS_USER_ID = '00000000-0000-4000-8000-00000000000f'`.

## Deviations from the parent spec, decided while planning

1. The price half of `trimForContext` is a suffix notice listing expired ids, not a rewrite of persisted transcript blocks (spec 3c §3).
2. The title is produced by the front desk's one call; the `titler` seat stays declared and unused.
3. One scout per driver step; the parent's "three parallel scouts" waits for a loop that answers several tool calls at once.
4. `check_transfers` is not built: no data source was ever chosen.

## File map

| File | Responsibility |
|---|---|
| `src/tools/escalate.ts`, `src/sweeper.ts` | Task 0 one-liners |
| `supabase/migrations/0015_plan_3c_seats.sql` | `desk` default `'front'`, `front_label`, `canary_runs`, `drift_alarms` |
| `src/worker.ts` | `AgentStep` `continue` variant and its loop branch |
| `src/agents/frontDesk.ts` + `prompts/front_desk.md` | The front desk agent |
| `src/agents/route.ts` | `routeAgent(deps)` by `conversations.desk` |
| `src/repo/conversations.ts` | `readDesk`, `setDeskPlanning`, `recordFrontLabel` |
| `src/sanitize.ts` | + `redactPrices`, `cutAtWords` |
| `src/pricing.ts`, `src/model/client.ts` | web search fee, `ModelUsage.server_tool_use` |
| `src/agents/scout.ts` + `prompts/scout.md` | The scout call |
| `src/tools/registry.ts`, `src/agents/driver.ts` | `research_destination`; expired-results suffix |
| `src/repo/toolResults.ts` | + `listExpiredSourceIds` |
| `src/notify.ts` | + `DriftAlarm`, `Notifier.alarm` |
| `src/monitor/drift.ts` | fingerprint, shape reduction, `runDriftMonitor` |
| `netlify/functions/drift-monitor.mts`, `netlify.toml` | nightly schedule |
| `.github/workflows/test.yml`, `supabase/ci-bootstrap.sql`, `scripts/ci-migrate.sh` | CI |
| `docs/…` | Task 11 |

---

### Task 0: Two one-liners from 3b's final review

**Files:**
- Modify: `src/tools/escalate.ts`, `src/sweeper.ts`
- Modify: `test/escalate.test.ts`, `test/sweeper.test.ts`

- [ ] **Step 1: Failing test, escalate** — append to `test/escalate.test.ts` inside the `describeDb`:

```ts
  it('does not fail the turn when the notified_at stamp fails after a successful notify', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07')
      const notify = vi.fn().mockResolvedValue(undefined)
      // A stamp that cannot land: make the escalations row unreachable for the update
      // by wrapping sql so that `update escalations set notified_at` throws.
      const failingSql = new Proxy(sql, {
        apply(target, thisArg, args: unknown[]) {
          const text = String((args[0] as TemplateStringsArray).join('?'))
          if (text.includes('update escalations set notified_at')) throw new Error('stamp down')
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
        },
      }) as typeof sql
      const out = await escalate({ sql: failingSql, notifier: { notify }, now: () => NOW.getTime() }, s, { reason: 'safety' })
      expect(out).toMatch(/escalated/i)
      expect(notify).toHaveBeenCalledTimes(1)
      const [e] = await sql`select notified_at from escalations where conversation_id = ${s.conversationId}`
      expect(e!.notified_at).toBeNull()
    })
  })
```

If the Proxy approach does not intercept postgres.js's tagged-template call (it is a function object; `apply` should), fall back to `vi.spyOn` on the `markNotified` export via `vi.mock('../src/repo/escalations.js', ...)` with `importOriginal`, and say so in the report.

Run `pnpm vitest run test/escalate.test.ts` → the new test FAILS with `stamp down` propagating.

- [ ] **Step 2: Fix** — in `src/tools/escalate.ts` replace `if (notified) await markNotified(deps.sql, e.id)` with:

```ts
  if (notified) {
    // Best-effort, like the notify itself: the row exists and the human was paged.
    await markNotified(deps.sql, e.id).catch((err: unknown) => {
      console.error(`escalate: notified_at stamp failed for ${e.id}: ${(err as Error).message}`)
    })
  }
```

Run → PASS.

- [ ] **Step 3: Failing test, sweeper** — append to `test/sweeper.test.ts`, copying the seeding of "fails a turn at MAX_ATTEMPTS with crash_loop…" but first `update conversations set status = 'escalated'` for that conversation; assert after `sweep` that the turn is `failed`/`crash_loop` AND the conversation status is still `'escalated'`. Run → FAILS (`'failed'`).

- [ ] **Step 4: Fix** — in `src/sweeper.ts` the `convo` CTE becomes:

```sql
      update conversations c
         set status = case when c.status = 'escalated' then 'escalated' else 'failed' end,
             updated_at = now()
        from reap r where c.id = r.conversation_id and c.user_id = r.user_id
```

Run → PASS. Full suite, typecheck, lint.

- [ ] **Step 5: Commit** — `fix(escalate,sweeper): notified_at stamp is best-effort; crash-loop reap keeps 'escalated'`.

---

### Task 1: Migration 0015 and its schema test

**Files:**
- Create: `supabase/migrations/0015_plan_3c_seats.sql`
- Create: `test/schema-3c.test.ts`

**Interfaces:**
- Produces: `conversations.desk` default `'front'`; `conversations.front_label text null check in ('new_trip','faq','unclear','fallback')`; tables `canary_runs`, `drift_alarms`.

- [ ] **Step 1: Failing test**

```ts
// test/schema-3c.test.ts
import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

const USER = '00000000-0000-4000-8000-00000000c001'

describeDb('0015 plan 3c schema', () => {
  it('starts a new conversation at the front desk', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning desk, front_label`
      expect(c!.desk).toBe('front')
      expect(c!.front_label).toBeNull()
    })
  })
  it('accepts the four front labels and refuses anything else', async () => {
    await withTestDb(async (sql) => {
      for (const l of ['new_trip', 'faq', 'unclear', 'fallback']) {
        const [c] = await sql`insert into conversations (user_id, front_label) values (${USER}, ${l}) returning front_label`
        expect(c!.front_label).toBe(l)
      }
      await expect(sql`insert into conversations (user_id, front_label) values (${USER}, 'greeting')`)
        .rejects.toThrow(/check constraint/i)
    })
  })
  it('stores a canary run and a drift alarm', async () => {
    await withTestDb(async (sql) => {
      const [r] = await sql`
        insert into canary_runs (seat, model, stop_reason, output_band, signal, request_id)
        values ('driver', 'claude-opus-5', 'tool_use', 'm', 'explore_flights', 'req_x') returning id, ran_at`
      expect(r!.ran_at).toBeInstanceOf(Date)
      const [a] = await sql`
        insert into drift_alarms (seat, "check", detail) values ('driver', 'canary', ${sql.json({ from: 'a', to: 'b' })})
        returning id, notified_at`
      expect(a!.notified_at).toBeNull()
      await expect(sql`insert into canary_runs (seat, model, stop_reason, output_band, signal) values ('nobody', 'm', 's', 'm', '')`)
        .rejects.toThrow(/check constraint/i)
      await expect(sql`insert into drift_alarms (seat, "check", detail) values ('driver', 'vibes', '{}')`)
        .rejects.toThrow(/check constraint/i)
    })
  })
})
```

Run → FAILS (`front_label` missing, `canary_runs` missing).

- [ ] **Step 2: Migration**

```sql
-- supabase/migrations/0015_plan_3c_seats.sql
--
-- Plan 3c.
--
-- 1. conversations.desk defaults to 'front': every new conversation is routed
--    by the front desk first (parent spec section 3). Existing rows keep
--    'planning' -- they were created before a front desk existed and must not
--    be re-triaged.
-- 2. conversations.front_label: the routing label, extracted at write time so
--    it outlives the 90-day model_calls window (parent section 7). 'fallback'
--    is the parse-failure / refusal route, distinct from a real 'unclear'.
-- 3. canary_runs / drift_alarms: the drift monitor's memory. A canary run is a
--    response fingerprint, never content; an alarm is a diff between two runs
--    or between a stored request shape and the code's current one.

alter table conversations alter column desk set default 'front';
alter table conversations add column front_label text
  check (front_label in ('new_trip','faq','unclear','fallback'));

create table canary_runs (
  id           uuid primary key default gen_random_uuid(),
  seat         text not null check (seat in ('front_desk','driver','scout','reviewer')),
  model        text not null,
  stop_reason  text not null,
  output_band  text not null check (output_band in ('xs','s','m','l','xl')),
  signal       text not null default '',
  request_id   text,
  ran_at       timestamptz not null default now()
);
create index canary_runs_by_seat on canary_runs (seat, ran_at desc);

create table drift_alarms (
  id           uuid primary key default gen_random_uuid(),
  seat         text not null,
  "check"      text not null check ("check" in ('canary','shape')),
  detail       jsonb not null,
  created_at   timestamptz not null default now(),
  notified_at  timestamptz
);
create index drift_alarms_recent on drift_alarms (created_at desc);

revoke all on canary_runs, drift_alarms from anon, authenticated;
alter table canary_runs  enable row level security;
alter table drift_alarms enable row level security;
```

Apply the way 0014 was applied (see `git log -1 --format=%B -- supabase/migrations/0014_plan_3b_gates.sql`). Run → PASS. Full suite: `test/schema-corpus.test.ts`'s FK-index audit must stay green (these tables carry no FKs). Any existing test that asserts a new conversation's `desk` is `'planning'` must be updated to `'front'`; grep `desk` in `test/`.

- [ ] **Step 3: Commit** — `feat(schema): migration 0015 — front desk routing, canary runs, drift alarms`.

---

### Task 2: The `continue` step in the worker

**Files:**
- Modify: `src/worker.ts` (`AgentStep`, `loop()`)
- Modify: `test/worker.test.ts`

**Interfaces:**
- Produces: `AgentStep` gains `| { kind: 'continue'; costMicros: bigint; recordedMicros?: bigint }`. `loop()` on `continue`: heartbeat, `recordSpend(costMicros)`, `turnSpend.total += costMicros`, `state.step + 1`, `saveTurnState`, next iteration. Nothing appended to `messages`.

- [ ] **Step 1: Failing test** — in `test/worker.test.ts`:

```ts
  it('a continue step calls the agent again in the SAME turn, appends nothing, and charges once', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'a week in Portugal')
      let calls = 0
      const agent: Agent = async ({ state }) => {
        calls++
        if (calls === 1) return { kind: 'continue', costMicros: 0n, recordedMicros: 300n }
        expect(state.messages).toHaveLength(1)          // nothing was appended by the continue
        expect(state.step).toBe(1)
        return { kind: 'message', text: `after ${calls}`, costMicros: 100n }
      }
      await runTurn(workerDeps(sql, agent), r.turnId!)
      expect(calls).toBe(2)
      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      expect(turn!.status).toBe('done')
      expect(BigInt(turn!.spend_usd_micros)).toBe(400n)   // 300 self-debited + 100 via recordSpend
      const [convo] = await sql<ConversationRow[]>`select * from conversations where id = ${r.conversationId}`
      expect(BigInt(convo!.spend_usd_micros)).toBe(100n)  // recordedMicros never reaches recordSpend
      const msgs = await sql<MessageRow[]>`select role from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(2)
    })
  })
```

Run → FAILS (typecheck: `'continue'` not assignable; or runtime: unhandled step).

- [ ] **Step 2: Implement** — add the variant with this doc comment:

```ts
  /**
   * "Call me again": the agent did work that ends no turn and adds nothing to
   * the transcript — the front desk routing a conversation to planning. The
   * step counter still advances so a misbehaving agent cannot loop forever
   * under maxSteps. `recordedMicros` follows the same rule as everywhere else:
   * already debited, folded into the turn total, never passed to recordSpend.
   */
  | { kind: 'continue'; costMicros: bigint; recordedMicros?: bigint }
```

In `loop()`'s switch, before `case 'tool'`:

```ts
      case 'continue': {
        await heartbeat(sql, claim)
        await recordSpend(sql, { userId: claim.userId, conversationId: claim.conversationId, costMicros: step.costMicros })
        turnSpend.total += step.costMicros
        state = { ...state, step: state.step + 1 }
        await saveTurnState(sql, claim, state)
        continue
      }
```

Run → PASS. Break: make `continue` skip `saveTurnState` and the `step + 1`; the `state.step` assertion fails. Restore. Break: pass `recordedMicros` into `recordSpend`; the conversation-spend assertion fails. Restore.

- [ ] **Step 3: Commit** — `feat(worker): continue step — call the agent again within one turn`.

---

### Task 3: The front desk agent

**Files:**
- Create: `src/agents/frontDesk.ts`, `src/agents/prompts/front_desk.md`, `src/repo/conversations.ts`
- Create: `test/front-desk.test.ts`

**Interfaces:**
- Consumes: `callModel`, `buildRequest`, `buildCountTokensRequest`, `estimateInputTokens`, `reserve`, `reconcile`, `estimateMicros`, `recordModelCall`, `firstCeilingReached`, `classifyError`, `costMicros`, `SYSTEM_CACHE_TTL`, `maskUntrustedText`.
- Produces:

```ts
// src/repo/conversations.ts
export type Desk = 'front' | 'planning'
export async function readDesk(sql, conversationId: string, userId: string): Promise<Desk>   // throws if not found
export async function routeToPlanning(sql, args: { conversationId; userId; title: string | null; label: FrontLabel }): Promise<void>
export async function recordFrontLabel(sql, args: { conversationId; userId; label: FrontLabel }): Promise<void>
// src/agents/frontDesk.ts
export type FrontLabel = 'new_trip' | 'faq' | 'unclear' | 'fallback'
export const FRONT_SCHEMA: Record<string, unknown>
export type FrontDeskDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }
export function makeFrontDesk(deps: FrontDeskDeps): Agent
export function parseFrontVerdict(result: ModelResult): { label: FrontLabel; answer: string | null; title: string | null }
```

- [ ] **Step 1: The prompt**

```md
<!-- src/agents/prompts/front_desk.md -->
You are the front desk of a small travel agency. A traveller has just sent
their first message. Decide one of three things and answer in the schema.

- `new_trip`: they want a trip planned, however vaguely. Set `title` to a short
  sidebar title made from what they said — destination, month, party size when
  present ("Portugal, September, 2 adults + toddler"). Never invent a fact for
  the title; leave a part out rather than guess. `answer` is null.
- `faq`: a question about the agency itself that needs no planning — what we
  do, that we hand out booking links rather than take payment, that we do not
  handle cancellations, changes or visas, how prices are checked. Put the
  answer in `answer`, two or three sentences, and set `title` null.
- `unclear`: anything else — a greeting with nothing to go on, an off-topic
  request, something you cannot classify. `answer` and `title` are null.

You never quote a price, never promise availability, and never write more than
the schema asks for. When in doubt between `new_trip` and `unclear`, choose
`new_trip`: the planning desk can ask; you cannot.
```

- [ ] **Step 2: Failing tests**

```ts
// test/front-desk.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeFrontDesk, parseFrontVerdict, FRONT_SCHEMA } from '../src/agents/frontDesk.js'
import { readDesk } from '../src/repo/conversations.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { ModelResult } from '../src/model/client.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const verdict = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn',
  model: 'claude-haiku-4-5-20251001', _request_id: 'req_f', usage })
const refusal = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null },
  model: 'claude-haiku-4-5-20251001', _request_id: 'req_f', usage }

async function seed(sql: postgres.Sql, n: string, text = 'a week in Portugal in September, two adults and a toddler') {
  const userId = `00000000-0000-4000-8000-000000000f${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id, desk`
  expect(c!.desk).toBe('front')
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'f' + n}, 'running') returning id`
  await sql`insert into messages (conversation_id, user_id, role, content) values (${c!.id}, ${userId}, 'user', ${text})`
  const ctx = { conversationId: c!.id as string, userId, turnId: t!.id as string,
    state: { step: 0, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] } }
  return ctx
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) =>
  ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })

describeDb('front desk', () => {
  it('new_trip: writes the title, moves the desk to planning, records the label, and continues', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '01')
      const create = vi.fn().mockResolvedValue(verdict({ label: 'new_trip', answer: null, title: 'Portugal, September, 2 adults + toddler' }))
      const step = await makeFrontDesk(deps(sql, create))(ctx)
      expect(step.kind).toBe('continue')
      if (step.kind !== 'continue') throw new Error('unreachable')
      expect(step.costMicros).toBe(0n)
      expect(step.recordedMicros).toBe(500n)          // 300*1 + 40*5
      const [c] = await sql`select desk, title, front_label from conversations where id = ${ctx.conversationId}`
      expect(c).toEqual({ desk: 'planning', title: 'Portugal, September, 2 adults + toddler', front_label: 'new_trip' })
      const sent = create.mock.calls[0]![0] as Record<string, unknown>
      expect(sent.model).toBe('claude-haiku-4-5-20251001')
      expect((sent.output_config as Record<string, unknown>).format).toEqual({ type: 'json_schema', schema: FRONT_SCHEMA })
      expect(sent.tools).toBeUndefined()
      const [mc] = await sql`select seat, capture_policy, prompt_version from model_calls where turn_id = ${ctx.turnId}`
      expect(mc).toMatchObject({ seat: 'front_desk', capture_policy: 'full', prompt_version: 'front_desk@1' })
    })
  })
  it('faq: parks with the answer, stays at the front desk, records the label', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '02', 'do you take payment?')
      const step = await makeFrontDesk(deps(sql, vi.fn().mockResolvedValue(verdict({ label: 'faq', answer: 'No. We hand you booking links; you pay the supplier.', title: null }))))(ctx)
      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toContain('booking links')
      expect(await readDesk(sql, ctx.conversationId, ctx.userId)).toBe('front')
      const [c] = await sql`select front_label, title from conversations where id = ${ctx.conversationId}`
      expect(c).toEqual({ front_label: 'faq', title: null })
    })
  })
  it.each([
    ['unclear', verdict({ label: 'unclear', answer: null, title: null }), 'unclear'],
    ['refusal', refusal, 'fallback'],
    ['not JSON', verdict('hi'), 'fallback'],
    ['wrong shape', verdict({ ok: true }), 'fallback'],
    ['faq without an answer', verdict({ label: 'faq', answer: null, title: null }), 'fallback'],
    ['new_trip without a title', verdict({ label: 'new_trip', answer: null, title: null }), 'fallback'],
    ['max_tokens stop', { ...verdict({ label: 'new_trip' }), stop_reason: 'max_tokens' }, 'fallback'],
  ])('%s routes to planning without a title, label %s', async (_, resp, label) => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '03')
      const step = await makeFrontDesk(deps(sql, vi.fn().mockResolvedValue(resp)))(ctx)
      expect(step.kind).toBe('continue')
      const [c] = await sql`select desk, title, front_label from conversations where id = ${ctx.conversationId}`
      expect(c).toEqual({ desk: 'planning', title: null, front_label: label })
    })
  })
  it('masks control characters in the title and the answer', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '04')
      await makeFrontDesk(deps(sql, vi.fn().mockResolvedValue(verdict({ label: 'new_trip', answer: null, title: 'Lisbon\n## x' }))))(ctx)
      const [c] = await sql`select title from conversations where id = ${ctx.conversationId}`
      expect(c!.title).toBe('Lisbon?## x')
    })
  })
  it('fails the turn limit_reached when the reservation crosses a ceiling, refunding', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '05')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${ctx.conversationId}`
      const create = vi.fn()
      const step = await makeFrontDesk(deps(sql, create))(ctx)
      expect(step.kind).toBe('fail'); if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('limit_reached')
      expect(create).not.toHaveBeenCalled()
      const [c] = await sql`select spend_usd_micros, desk from conversations where id = ${ctx.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(DEFAULT_LIMITS.conversationCeilingMicros)
      expect(c!.desk).toBe('front')
    })
  })
  it('parseFrontVerdict never returns faq without an answer or new_trip without a title', () => {
    const ok = (v: unknown): ModelResult => ({ kind: 'ok', content: [{ type: 'text', text: JSON.stringify(v) }], stopReason: 'end_turn', model: 'm', requestId: null, usage, latencyMs: 1 })
    expect(parseFrontVerdict(ok({ label: 'faq', answer: '', title: null })).label).toBe('fallback')
    expect(parseFrontVerdict(ok({ label: 'new_trip', answer: null, title: '' })).label).toBe('fallback')
    expect(parseFrontVerdict(ok({ label: 'new_trip', answer: 'x', title: 'T' }))).toEqual({ label: 'new_trip', answer: null, title: 'T' })
  })
})
```

Run → FAILS, cannot resolve modules.

- [ ] **Step 3: Implement the repo**

```ts
// src/repo/conversations.ts
import type postgres from 'postgres'
import type { FrontLabel } from '../agents/frontDesk.js'

export type Desk = 'front' | 'planning'

export async function readDesk(sql: postgres.Sql, conversationId: string, userId: string): Promise<Desk> {
  const rows = await sql<{ desk: Desk }[]>`
    select desk from conversations where id = ${conversationId} and user_id = ${userId}`
  if (rows.length === 0) throw new Error(`readDesk: conversation ${conversationId} not found for this user`)
  return rows[0]!.desk
}

/** One statement: desk, label and (optional) title move together, so a crash cannot leave a titled conversation still at the front desk. */
export async function routeToPlanning(
  sql: postgres.Sql, args: { conversationId: string; userId: string; title: string | null; label: FrontLabel },
): Promise<void> {
  await sql`update conversations
               set desk = 'planning', front_label = ${args.label},
                   title = coalesce(${args.title}, title), updated_at = now()
             where id = ${args.conversationId} and user_id = ${args.userId}`
}

export async function recordFrontLabel(
  sql: postgres.Sql, args: { conversationId: string; userId: string; label: FrontLabel },
): Promise<void> {
  await sql`update conversations set front_label = ${args.label}, updated_at = now()
             where id = ${args.conversationId} and user_id = ${args.userId}`
}
```

- [ ] **Step 4: Implement the agent**

```ts
// src/agents/frontDesk.ts
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { z } from 'zod'
import type { Agent, AgentContext, AgentStep } from '../worker.js'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { buildCountTokensRequest, buildRequest, callModel, estimateInputTokens, type CallArgs, type ModelResult, type Transport } from '../model/client.js'
import { costMicros } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { recordFrontLabel, routeToPlanning } from '../repo/conversations.js'
import { maskUntrustedText } from '../sanitize.js'

const SYSTEM = readFileSync(new URL('./prompts/front_desk.md', import.meta.url), 'utf8')

export type FrontLabel = 'new_trip' | 'faq' | 'unclear' | 'fallback'

const Verdict = z.strictObject({
  label: z.enum(['new_trip', 'faq', 'unclear']),
  answer: z.string().nullable(),
  title: z.string().nullable(),
})

/** Hand-written: the API rejects zod's length keywords. */
export const FRONT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['new_trip', 'faq', 'unclear'] },
    answer: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
  },
  required: ['label', 'answer', 'title'],
  additionalProperties: false,
}

export type FrontDeskDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * Parent spec section 3: a fixed label set via structured output; on any parse
 * failure it routes to planning, never guesses, never drops. Every way the
 * verdict can be unusable — refusal, truncation, bad JSON, wrong shape, a faq
 * with nothing to say, a trip with no title — is the same outcome: 'fallback',
 * which routes to planning without a title. Only a whole verdict is trusted.
 */
export function parseFrontVerdict(result: ModelResult): { label: FrontLabel; answer: string | null; title: string | null } {
  const fallback = { label: 'fallback' as const, answer: null, title: null }
  if (result.kind === 'refused' || result.stopReason !== 'end_turn') return fallback
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim()
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fallback }
  const parsed = Verdict.safeParse(raw)
  if (!parsed.success) return fallback
  const v = parsed.data
  if (v.label === 'faq') {
    if (v.answer === null || v.answer.trim().length === 0) return fallback
    return { label: 'faq', answer: maskUntrustedText(v.answer), title: null }
  }
  if (v.label === 'new_trip') {
    if (v.title === null || v.title.trim().length === 0) return fallback
    return { label: 'new_trip', answer: null, title: maskUntrustedText(v.title) }
  }
  return { label: 'unclear', answer: null, title: null }
}

export function makeFrontDesk(deps: FrontDeskDeps): Agent {
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql } = deps
    const seat = SEATS.front_desk
    const args: CallArgs = {
      seat, system: SYSTEM, tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: lastUserText(ctx) }] }],
      outputSchema: FRONT_SCHEMA,
    }
    const inputTokens = deps.transport.countTokens
      ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
      : estimateInputTokens(args)
    const reserved = estimateMicros(seat, inputTokens)
    const { conversationMicros, dailyMicros, day } = await reserve(sql, { userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved })
    const refund = () => reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day })
    const reached = firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits)
    if (reached !== null) {
      await refund()
      return { kind: 'fail', reason: 'limit_reached', recordedMicros: 0n,
        message: reached === 'conversation'
          ? 'This conversation has reached its spending limit, so I have stopped here rather than run up more. Start a new conversation and I will pick up from what we agreed.'
          : 'We have reached today’s spending limit, so I have stopped here rather than run up more. Come back tomorrow and I will pick up from what we agreed.' }
    }
    let result: ModelResult
    try { result = await callModel(deps.transport, args, deps.now) }
    catch (err) { if (classifyError(err).billed === 'no') await refund(); throw err }
    const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)
    await reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day })
    await recordModelCall(sql, { conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
      seat: 'front_desk', seatConfig: seat, result, systemPrompt: SYSTEM, userPrompt: lastUserText(ctx),
      requestShape: buildRequest(args), thinkingMode: null, costMicros: actual })

    const v = parseFrontVerdict(result)
    if (v.label === 'faq') {
      await recordFrontLabel(sql, { conversationId: ctx.conversationId, userId: ctx.userId, label: 'faq' })
      return { kind: 'park', message: v.answer!, costMicros: 0n, recordedMicros: actual }
    }
    await routeToPlanning(sql, { conversationId: ctx.conversationId, userId: ctx.userId, title: v.title, label: v.label })
    return { kind: 'continue', costMicros: 0n, recordedMicros: actual }
  }
}

function lastUserText(ctx: AgentContext): string {
  for (let i = ctx.state.messages.length - 1; i >= 0; i--) {
    const m = ctx.state.messages[i]!
    if (m.role !== 'user') continue
    const t = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (t.length > 0) return t
  }
  return ''
}
```

`thinkingMode: null` because Haiku sends no `thinking` block — check `buildRequest`: it always sends `thinking: { type: 'adaptive' }`. Haiku 4.5 does not accept adaptive thinking (it takes `budget_tokens` or nothing). **Add to `buildRequest`:** omit `thinking` entirely when `seat.effort === null` (the Haiku seats), and add the shape test `it('sends no thinking block for a seat that takes no effort')`. Record `thinkingMode: null` for those rows. This is the first Haiku call in the repo; the live pin in Task 9's canary confirms the API accepts it.

Run → PASS. Break: in `parseFrontVerdict` return `v` unmodified for `faq` with an empty answer; the table test row fails. Restore. Break: drop the ceiling block; the ceiling test fails. Restore.

- [ ] **Step 5: Commit** — `feat(front-desk): Haiku front desk — fixed labels, title, routes to planning on any doubt`.

---

### Task 4: The router, end to end

**Files:**
- Create: `src/agents/route.ts`
- Modify: `scripts/demo.ts` (the live scenario's agent becomes `routeAgent`), `test/driver.test.ts` if any test creates a conversation and expects the driver to run first (seed `desk = 'planning'` explicitly there)
- Create: `test/route.test.ts`

**Interfaces:**
- Produces: `export function routeAgent(deps: DriverDeps): Agent` — reads `readDesk` each step; `'front'` → `makeFrontDesk(deps)`, `'planning'` → `makeDriver(deps)`. `DriverDeps` already satisfies `FrontDeskDeps` structurally.

- [ ] **Step 1: Failing test**

```ts
// test/route.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { routeAgent } from '../src/agents/route.js'
import { runTurn } from '../src/worker.js'
import { submitMessage } from '../src/handler.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER = '00000000-0000-4000-8000-00000000d001'
const usage = { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const frontVerdict = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn', model: 'claude-haiku-4-5-20251001', _request_id: 'r1', usage })
const driverText = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r2', usage })

const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) => ({
  sql, transport: { create }, flights: new MockSupplier({ kind: 'flight' }), hotels: new MockSupplier({ kind: 'hotel' }),
  limits: DEFAULT_LIMITS, now: () => Date.now(), notifier: new LogNotifier(() => {}),
})

describeDb('routeAgent', () => {
  it('front desk then driver in ONE turn: two seats, two ledger rows, one agent message, title set', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'a week in Portugal in September', idempotencyKey: 'k1' })
      const create = vi.fn()
        .mockResolvedValueOnce(frontVerdict({ label: 'new_trip', answer: null, title: 'Portugal, September' }))
        .mockResolvedValueOnce(driverText('September in the Algarve, then. When would you fly?'))
      await runTurn({ sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create)), now: () => Date.now(),
        deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {} }, r.turnId!)
      expect(create).toHaveBeenCalledTimes(2)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(new Set(seats.map((s) => s.seat))).toEqual(new Set(['front_desk', 'driver']))
      const [c] = await sql`select desk, title, status, spend_usd_micros from conversations where id = ${r.conversationId}`
      expect(c!.desk).toBe('planning'); expect(c!.title).toBe('Portugal, September'); expect(c!.status).toBe('awaiting_user')
      expect(BigInt(c!.spend_usd_micros as string)).toBe(500n + 6_000n)  // haiku 300*1+40*5, opus 300*5+40*25... compute: 1500+1000 = 2500 → fix below
      const msgs = await sql`select role, content from messages where conversation_id = ${r.conversationId} order by created_at`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toContain('Algarve')
      const [t] = await sql`select spend_usd_micros from turns where id = ${r.turnId}`
      expect(BigInt(t!.spend_usd_micros as string)).toBe(BigInt(c!.spend_usd_micros as string))
    })
  })
  it('a faq parks at the front desk; the NEXT turn still goes to the front desk', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'do you take payment?', idempotencyKey: 'k2' })
      const create = vi.fn().mockResolvedValue(frontVerdict({ label: 'faq', answer: 'No, you pay the supplier.', title: null }))
      const w = { sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create)), now: () => Date.now(), deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {} }
      await runTurn(w, r.turnId!)
      const r2 = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: r.conversationId, message: 'and cancellations?', idempotencyKey: 'k3' })
      await runTurn(w, r2.turnId!)
      expect(create).toHaveBeenCalledTimes(2)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(seats.every((s) => s.seat === 'front_desk')).toBe(true)
    })
  })
  it('a conversation already at planning never sees the front desk', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'k4' })
      await sql`update conversations set desk = 'planning' where id = ${r.conversationId}`
      const create = vi.fn().mockResolvedValue(driverText('Hello. Where to?'))
      await runTurn({ sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create)), now: () => Date.now(), deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {} }, r.turnId!)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(seats.map((s) => s.seat)).toEqual(['driver'])
    })
  })
})
```

Compute the spend constant in test 1 from `PRICES`: Haiku 300×1 + 40×5 = 500; Opus 300×5 + 40×25 = 2 500; total 3 000n. Replace the placeholder expression with `3_000n` and delete the comment.

- [ ] **Step 2: Implement**

```ts
// src/agents/route.ts
import type { Agent, AgentContext, AgentStep } from '../worker.js'
import { makeDriver, type DriverDeps } from './driver.js'
import { makeFrontDesk } from './frontDesk.js'
import { readDesk } from '../repo/conversations.js'

/**
 * Parent spec section 3: the front desk sees the first message and "then never
 * appears again". The flag is `conversations.desk`, read on EVERY step rather
 * than once per turn, because the front desk flips it mid-turn and returns a
 * `continue` — the next step of the same turn must land on the driver.
 */
export function routeAgent(deps: DriverDeps): Agent {
  const front = makeFrontDesk(deps)
  const driver = makeDriver(deps)
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const desk = await readDesk(deps.sql, ctx.conversationId, ctx.userId)
    return desk === 'front' ? front(ctx) : driver(ctx)
  }
}
```

In `scripts/demo.ts`, the live scenario's `agent: makeDriver(...)` becomes `agent: routeAgent(...)` (the demo's conversation is created by `submitMessage`, so it starts at the front desk; the live run now makes one Haiku call first — say so in the scenario's narration). Do NOT touch `netlify/functions/run-turn-background.mts`; it still runs `echoAgent` and plan 4 wires the router (work log, "What 4 needs").

Run → PASS. Break: make `routeAgent` read the desk once outside the closure; test 1 fails (the driver is never reached in the same turn). Restore.

- [ ] **Step 3: Commit** — `feat(agents): routeAgent — front desk first, driver after, one turn`.

---

### Task 5: `redactPrices` and `cutAtWords`

**Files:**
- Modify: `src/sanitize.ts`
- Modify: `test/tools.test.ts` (or a new `test/sanitize.test.ts` — create it; keep `sanitize` tests together)

**Interfaces:**
- Produces:

```ts
export const PRICE_REDACTED = '[price removed]'
export function redactPrices(text: string): string
export function cutAtWords(text: string, maxWords: number): { text: string; cut: boolean }
```

- [ ] **Step 1: Failing tests**

```ts
// test/sanitize.test.ts
import { describe, expect, it } from 'vitest'
import { redactPrices, cutAtWords, PRICE_REDACTED, maskUntrustedText } from '../src/sanitize.js'

describe('redactPrices', () => {
  it.each([
    ['rooms from €89 a night', `rooms from ${PRICE_REDACTED} a night`],
    ['about $1,200 return', `about ${PRICE_REDACTED} return`],
    ['EUR 45 per person', `${PRICE_REDACTED} per person`],
    ['45 EUR per person', `${PRICE_REDACTED} per person`],
    ['£12.50pp', `${PRICE_REDACTED}pp`],
    ['around 120 per night', `around ${PRICE_REDACTED} per night`],
    ['costs 30 pp', `costs ${PRICE_REDACTED} pp`],
    ['1.200,00 EUR', `${PRICE_REDACTED}`],
    ['USD1200', `${PRICE_REDACTED}`],
  ])('redacts %j', (input, expected) => expect(redactPrices(input)).toBe(expected))
  it.each([
    'Terminal 2 is 12 minutes by metro',
    'the 15th-century castle',
    'a 3-night minimum in August',
    'bus 27 runs every 20 minutes',
    'population 500,000',
  ])('leaves %j alone', (s) => expect(redactPrices(s)).toBe(s))
  it('never touches the fence delimiters or the untrusted marker', () => {
    const s = '<tool_result name="x" trust="untrusted">€5</tool_result>'
    expect(redactPrices(s)).toBe(`<tool_result name="x" trust="untrusted">${PRICE_REDACTED}</tool_result>`)
  })
})

describe('cutAtWords', () => {
  it('returns short text untouched', () => expect(cutAtWords('one two three', 5)).toEqual({ text: 'one two three', cut: false }))
  it('cuts at the last sentence end under the cap', () => {
    const t = 'First sentence here. Second one is here. Third goes on and on and on.'
    const r = cutAtWords(t, 7)
    expect(r).toEqual({ text: 'First sentence here. Second one is here.', cut: true })
  })
  it('cuts at the word cap when there is no sentence end', () => {
    expect(cutAtWords('a b c d e f g h', 3)).toEqual({ text: 'a b c', cut: true })
  })
})

describe('maskUntrustedText', () => {
  it('is unchanged by this plan', () => expect(maskUntrustedText('a\nb')).toBe('a?b'))
})
```

Run → FAILS.

- [ ] **Step 2: Implement** (append to `src/sanitize.ts`)

```ts
export const PRICE_REDACTED = '[price removed]'

// A number with optional thousands separators and decimals, in either the
// 1,200.50 or the 1.200,50 convention.
const NUM = String.raw`\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
const SYM = String.raw`[€$£¥]`
const ISO = String.raw`(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK|HUF|RON)`
const UNIT = String.raw`(?:per\s+(?:night|person|adult|day|week|room)|pp|p\.p\.|a\s+night|each)`

const PRICE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${SYM}\s?(?:${NUM})`, 'g'),                        // €89, $1,200
  new RegExp(String.raw`\b${ISO}\s?(?:${NUM})\b`, 'g'),                    // EUR 45, USD1200
  new RegExp(String.raw`\b(?:${NUM})\s?${ISO}\b`, 'g'),                    // 45 EUR
  new RegExp(String.raw`\b(?:${NUM})(?=\s?${UNIT}\b)`, 'g'),               // 120 per night, 30 pp
]

/**
 * Parent spec section 9: "a deterministic post-filter redacts currency-shaped
 * tokens". Used on scout briefs now (section 4: "words never prices") and on
 * the streamed prose channel in plan 4. Deliberately over-eager: a redacted
 * "population 500,000 EUR" is a harmless oddity; a surviving "from €89" is the
 * one failure this product must not have. Bare numbers without a currency or a
 * per-unit word are left alone — durations, bus numbers, centuries.
 */
export function redactPrices(text: string): string {
  let out = text
  for (const re of PRICE_PATTERNS) out = out.replace(re, PRICE_REDACTED)
  return out
}

/** Cuts to at most `maxWords`, preferring the last sentence boundary under the cap. */
export function cutAtWords(text: string, maxWords: number): { text: string; cut: boolean } {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length <= maxWords) return { text, cut: false }
  const head = words.slice(0, maxWords).join(' ')
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.endsWith('.') ? head.length - 1 : -1)
  return { text: lastStop > 0 ? head.slice(0, lastStop + 1) : head, cut: true }
}
```

Adjust the regex until the table passes exactly; the table is the contract, not the regex. Run → PASS.

- [ ] **Step 3: Commit** — `feat(sanitize): redactPrices and cutAtWords — words never prices, by code`.

---

### Task 6: Web search in the pricing table and the usage type

**Files:**
- Modify: `src/pricing.ts`, `src/model/client.ts`, `src/repo/reservation.ts`
- Modify: `test/model-client.test.ts`, `test/reservation.test.ts`, `test/money.test.ts` or wherever `costMicros` is tested (grep `costMicros(`)

**Interfaces:**
- Produces:

```ts
// pricing.ts
export const WEB_SEARCH_MICROS = 10_000n
export type Usage = { ...existing; server_tool_use?: { web_search_requests: number } }
// costMicros now adds web_search_requests × WEB_SEARCH_MICROS
// client.ts
export type ModelUsage = { ...existing; server_tool_use?: { web_search_requests: number } }
// reservation.ts
export function estimateMicros(seat: Seat, inputTokens: number, extraMicros: bigint = 0n): bigint
// client.ts buildRequest: omits `thinking` when seat.effort === null (Task 3 already added this; confirm)
```

- [ ] **Step 1: Failing tests**

```ts
// in test/model-client.test.ts, describe('buildRequest')
  it('sends no thinking block for a seat that takes no effort (Haiku rejects adaptive)', () => {
    const req = buildRequest({ ...base, seat: SEATS.scout })
    expect(req.thinking).toBeUndefined()
  })
// in the costMicros tests
  it('charges each web search at $10 per 1,000 on top of tokens', () => {
    const u = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }
    expect(costMicros('claude-haiku-4-5-20251001', u, '1h')).toBe(1_000n + 3n * WEB_SEARCH_MICROS)
  })
  it('charges nothing extra when server_tool_use is absent', () => {
    const u = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
    expect(costMicros('claude-haiku-4-5-20251001', u, '1h')).toBe(1_000n)
  })
// in test/reservation.test.ts
  it('estimateMicros adds an extra upper bound when asked', () => {
    expect(estimateMicros(SEATS.scout, 100, 30_000n)).toBe(estimateMicros(SEATS.scout, 100) + 30_000n)
  })
```

Run → FAILS.

- [ ] **Step 2: Implement** — in `pricing.ts` add the constant and the optional field, and in `costMicros` after the token arithmetic: `+ (u.server_tool_use?.web_search_requests ?? 0) * Number(WEB_SEARCH_MICROS)` inside the rounded-up expression (keep the round-UP). Mirror the optional field on `ModelUsage`. In `reservation.ts`, `estimateMicros(seat, inputTokens, extraMicros = 0n)` returns the existing bound plus `extraMicros`; doc: "a server-side tool the seat may call up to N times is bounded at N × its fee, known before the call". Run → PASS.

- [ ] **Step 3: Commit** — `feat(pricing): web search fee in the ledger; Haiku seats send no thinking block`.

---

### Task 7: Scouts — `research_destination`

**Files:**
- Create: `src/agents/scout.ts`, `src/agents/prompts/scout.md`
- Modify: `src/tools/registry.ts` (schema, `door: 'worker'`, `DESK_TOOLS`), `src/agents/driver.ts` (case), `test/tools.test.ts` (fixture; the worker-door fence test may need the new tool)
- Create: `test/scout.test.ts`

**Interfaces:**
- Produces:

```ts
// registry.ts
export const ResearchDestination = z.strictObject({ city: z.string().min(1).max(80) })
// scout.ts
export const SCOUT_MAX_WORDS = 300
export const SCOUT_MAX_SEARCHES = 3
export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: SCOUT_MAX_SEARCHES } as const
export type ScoutDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }
export async function researchDestination(deps: ScoutDeps, ctx: { conversationId; userId; turnId }, spent: { micros: bigint }, city: string): Promise<string>
```

The return is the brief text (already redacted, cut, and masked); the driver fences it because the door is `worker`.

- [ ] **Step 1: Prompt**

```md
<!-- src/agents/prompts/scout.md -->
You are a destination scout for a small travel agency. You are given one city
and the traveller's notebook. Write a brief of at most 300 words a planner can
use: which neighbourhoods suit this party, what the season is like in their
month, how to get in from the airport and roughly how long it takes, what to
avoid, and one or two things worth knowing that a guidebook would not lead with.

You may search the web up to three times. Prefer official or well-known
sources. Do not quote or paraphrase any price, fare, rate or budget figure —
the office removes them anyway and it wastes words. Do not recommend a specific
hotel or flight. Plain prose, no headings, no lists.
```

- [ ] **Step 2: Failing tests**

```ts
// test/scout.test.ts
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { researchDestination, WEB_SEARCH_TOOL, SCOUT_MAX_WORDS } from '../src/agents/scout.js'
import { WEB_SEARCH_MICROS } from '../src/pricing.js'
import { PRICE_REDACTED } from '../src/sanitize.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const usage = (searches: number) => ({ input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200,
  server_tool_use: { web_search_requests: searches } })
const brief = (text: string, searches = 2) => ({
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Faro airport transfer' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn', model: 'claude-haiku-4-5-20251001', _request_id: 'req_s', usage: usage(searches),
})
async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-00000000e0${n}`
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'s' + n}, 'running') returning id`
  return { conversationId: c!.id as string, userId, turnId: t!.id as string }
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) => ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })

describeDb('scout', () => {
  it('offers exactly the web search tool capped at 3, no thinking, the scout seat', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '1')
      const create = vi.fn().mockResolvedValue(brief('Faro is the gateway to the Algarve.'))
      await researchDestination(deps(sql, create), s, { micros: 0n }, 'Faro')
      const sent = create.mock.calls[0]![0] as Record<string, unknown>
      expect(sent.tools).toEqual([WEB_SEARCH_TOOL]); expect(sent.thinking).toBeUndefined()
      expect(sent.model).toBe('claude-haiku-4-5-20251001')
    })
  })
  it('reserves the search cap up front and reconciles to the searches actually made', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '2')
      let during = 0n
      const create = vi.fn().mockImplementation(async () => {
        const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
        during = BigInt(c!.spend_usd_micros as string); return brief('Faro.', 2)
      })
      const spent = { micros: 0n }
      await researchDestination(deps(sql, create), s, spent, 'Faro')
      expect(during).toBeGreaterThanOrEqual(3n * WEB_SEARCH_MICROS)
      const [after] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      const expected = 1000n * 1n + 200n * 5n + 2n * WEB_SEARCH_MICROS
      expect(BigInt(after!.spend_usd_micros as string)).toBe(expected)
      expect(spent.micros).toBe(expected)
      const [mc] = await sql`select seat, cost_micros from model_calls where turn_id = ${s.turnId}`
      expect(mc!.seat).toBe('scout'); expect(BigInt(mc!.cost_micros as string)).toBe(expected)
    })
  })
  it('redacts prices, masks control characters, and cuts at 300 words, telling the planner', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '3')
      const long = Array.from({ length: 320 }, (_, i) => (i % 40 === 39 ? 'word.' : 'word')).join(' ')
      const out = await researchDestination(deps(sql, vi.fn().mockResolvedValue(brief(`Rooms from €89.\n## Injected\n${long}`))), s, { micros: 0n }, 'Faro')
      expect(out).toContain(PRICE_REDACTED); expect(out).not.toContain('€89'); expect(out).not.toContain('\n## Injected')
      expect(out.split(/\s+/).length).toBeLessThanOrEqual(SCOUT_MAX_WORDS + 12)   // the trailer
      expect(out).toMatch(/cut at 300 words/i)
    })
  })
  it('a refusal or an empty brief becomes a readable "no brief" result, and charges nothing on refusal', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '4')
      const refusal = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, model: 'claude-haiku-4-5-20251001', _request_id: 'r', usage: usage(0) }
      const out = await researchDestination(deps(sql, vi.fn().mockResolvedValue(refusal)), s, { micros: 0n }, 'Faro')
      expect(out).toMatch(/no brief/i)
      const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(0n)
    })
  })
  it('skips the call at the ceiling and says so', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '5')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const create = vi.fn()
      const out = await researchDestination(deps(sql, create), s, { micros: 0n }, 'Faro')
      expect(create).not.toHaveBeenCalled(); expect(out).toMatch(/spending limit/i)
    })
  })
})
```

And in `test/driver.test.ts`, one test: a `research_destination` tool response → `step.kind === 'tool'`, `run()` output contains `trust="untrusted"` and the brief text; `step.spent!.micros` equals the scout's cost. Fixture in `test/tools.test.ts`: `research_destination: { city: 'Faro' }`. Note the fixture loop there iterates `door === 'code'` tools only; add a parallel `VALID_INPUT` entry anyway so `validateToolCall` is exercised in the driver test.

- [ ] **Step 3: Implement**

```ts
// src/agents/scout.ts
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { buildCountTokensRequest, buildRequest, callModel, estimateInputTokens, type CallArgs, type ModelResult, type Transport } from '../model/client.js'
import { costMicros, WEB_SEARCH_MICROS } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { cutAtWords, maskControlChars, maskUntrustedText, redactPrices } from '../sanitize.js'

const SYSTEM = readFileSync(new URL('./prompts/scout.md', import.meta.url), 'utf8')
export const SCOUT_MAX_WORDS = 300
export const SCOUT_MAX_SEARCHES = 3
/** The only tool a scout holds: read-only, server-side, no outbound channel of ours. */
export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: SCOUT_MAX_SEARCHES } as const

export type ScoutDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * Parent spec section 4: "One city, ≤300 words, words never prices." The brief is
 * a model's paraphrase of untrusted pages (section 10), so on the way back it is
 * price-redacted, control-masked, and cut — and the driver fences it because the
 * tool's door is 'worker'. Charged to her, like every seat (section 8), with the
 * search cap reserved up front because the count is only known afterwards.
 */
export async function researchDestination(
  deps: ScoutDeps, ctx: { conversationId: string; userId: string; turnId: string },
  spent: { micros: bigint }, city: string,
): Promise<string> {
  const { sql } = deps
  const seat = SEATS.scout
  const args: CallArgs = {
    seat, system: SYSTEM, tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: `City: ${maskUntrustedText(city)}` }] }],
  }
  const inputTokens = deps.transport.countTokens
    ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
    : estimateInputTokens(args)
  const reserved = estimateMicros(seat, inputTokens, BigInt(SCOUT_MAX_SEARCHES) * WEB_SEARCH_MICROS)
  const { conversationMicros, dailyMicros, day } = await reserve(sql, { userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved })
  const refund = () => reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day })
  if (firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits) !== null) {
    await refund()
    return 'No brief: the spending limit is reached. Plan from what you know, or ask her.'
  }
  let result: ModelResult
  try { result = await callModel(deps.transport, args, deps.now) }
  catch (err) { if (classifyError(err).billed === 'no') await refund(); throw err }
  const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)
  await reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day })
  spent.micros += actual
  await recordModelCall(sql, { conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'scout', seatConfig: seat, result, systemPrompt: SYSTEM, userPrompt: city,
    requestShape: buildRequest(args), thinkingMode: null, costMicros: actual })
  if (result.kind === 'refused') return 'No brief: the scout declined this city. Plan from what you know, or ask her.'
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
  if (text.length === 0) return 'No brief: the scout returned nothing. Plan from what you know, or ask her.'
  const { text: cut, cut: wasCut } = cutAtWords(maskControlChars(redactPrices(text)), SCOUT_MAX_WORDS)
  return wasCut ? `${cut}\n[brief cut at ${SCOUT_MAX_WORDS} words]` : cut
}
```

`maskUntrustedText` caps length at 128 and masks non-ASCII — that is for ids and supplier names. The brief is our own model's prose: use `maskControlChars` (added in Task 3's fix round: strips C0/C1 controls and U+2028/9 only, keeps Unicode letters, no cap) instead of `maskUntrustedText` in the line `cutAtWords(maskUntrustedText(redactPrices(text)), …)`. The scout test's `\n## Injected` assertion holds either way.

`ContentBlock` in `src/engine.ts` must tolerate the two server-tool block types at runtime; `callModel` casts `raw.content` without validating block types, and the scout reads only `text` blocks, so no type change is needed. Add a comment in `scout.ts` saying so.

Registry: `research_destination: { name: 'research_destination', door: 'worker', schema: ResearchDestination, description: 'Ask a scout for a 300-word brief on one city for this traveller: neighbourhoods, season, airport transfer, what to avoid. Words only — it never returns prices.' }`, added to `DESK_TOOLS.planning`. Driver case:

```ts
    case 'research_destination': {
      const { city } = input as { city: string }
      return researchDestination({ sql, transport: deps.transport, limits: deps.limits, now: deps.now }, ctx, spent, city)
    }
```

Run → PASS. Break: remove `redactPrices`; the redaction test fails. Restore. Break: reserve without the search cap; the "reserves the cap" test fails. Restore.

- [ ] **Step 4: Commit** — `feat(scout): research_destination — Haiku with web search, redacted, cut, fenced, charged`.

---

### Task 8: The expired-results notice

**Files:**
- Modify: `src/repo/toolResults.ts` (+ `listExpiredSourceIds`), `src/agents/driver.ts` (suffix), `src/tools/validate.ts` (comment only)
- Modify: `test/toolResults.test.ts`, `test/driver.test.ts`

**Interfaces:**
- Produces: `listExpiredSourceIds(sql, conversationId: string, now: Date): Promise<string[]>` — the newest row per `source_id` whose `fetched_at + ttl_seconds < now`, sorted. `renderExpiredNotice(ids: string[]): string` in `driver.ts` (exported for the test), empty string when none.

- [ ] **Step 1: Failing tests** — in `test/toolResults.test.ts`: seed two searches through `recordResults` with `now` 30 minutes apart against `MockSupplier` (ttl 900 s); at a `now` 20 minutes after the second, the first batch's ids are expired and the second's are not; a re-fetch of one expired id (a newer row) removes it from the list; another conversation's ids never appear. In `test/driver.test.ts`: with one expired batch in the corpus, the request the transport receives ends with a user text block containing `## Expired results` and the ids, each passed through `sanitizeSourceId`; with none expired, no such block.

- [ ] **Step 2: Implement**

```ts
// toolResults.ts
/** Newest row per source id, then the ones past their own ttl. The gate's freshness rule, as a warning the model reads before it proposes. */
export async function listExpiredSourceIds(sql: postgres.Sql, conversationId: string, now: Date): Promise<string[]> {
  const rows = await sql<{ source_id: string }[]>`
    select source_id from (
      select distinct on (source_id) source_id, fetched_at, ttl_seconds
        from tool_results where conversation_id = ${conversationId}
       order by source_id, fetched_at desc, id desc) newest
     where fetched_at + make_interval(secs => ttl_seconds) < ${now}
     order by source_id`
  return rows.map((r) => r.source_id)
}
```

In `driver.ts`: `export function renderExpiredNotice(ids: string[]): string` returning `''` or `## Expired results\nThese ids are no longer quotable: ${ids.map(sanitizeSourceId).join(', ')}. Re-search before proposing them.`; in `makeDriver` compute `const expired = await listExpiredSourceIds(sql, ctx.conversationId, new Date(deps.now()))` and set `suffix: [renderNotebook(notebook), renderExpiredNotice(expired)].filter((s) => s.length > 0).join('\n\n')`. Update the `trimForContext` doc comment in `validate.ts`: the price half is implemented as the driver's expired-results notice (plan 3c §3), not here. Run → PASS. Break: drop the `distinct on`; the re-fetch test fails. Restore.

- [ ] **Step 3: Commit** — `feat(driver): expired-results notice in the suffix — the price half of trimForContext, as a warning`.

---

### Task 9: The drift monitor

**Files:**
- Modify: `src/notify.ts` (+ `DriftAlarm`, `Notifier.alarm`, `LogNotifier.alarm`), `test/escalate.test.ts` (LogNotifier.alarm line test)
- Create: `src/monitor/drift.ts`, `src/repo/drift.ts`, `netlify/functions/drift-monitor.mts`
- Modify: `netlify.toml` (schedule), `test/driver.live.test.ts` (one live canary pin per Haiku seat)
- Create: `test/drift.test.ts`

**Interfaces:**
- Produces:

```ts
// notify.ts
export type DriftAlarm = { id: string; seat: string; check: 'canary' | 'shape'; detail: Record<string, unknown>; createdAt: Date }
export interface Notifier { notify(e: Escalation): Promise<void>; alarm(a: DriftAlarm): Promise<void> }
// repo/drift.ts
export type CanaryRun = { seat: CanarySeat; model: string; stopReason: string; outputBand: Band; signal: string; requestId: string | null }
export type Band = 'xs' | 's' | 'm' | 'l' | 'xl'
export async function recordCanaryRun(sql, run: CanaryRun): Promise<void>
export async function previousCanaryRun(sql, seat: CanarySeat): Promise<CanaryRun | null>
export async function recordAlarm(sql, a: { seat: string; check: 'canary' | 'shape'; detail: Record<string, unknown> }): Promise<DriftAlarm>
export async function markAlarmNotified(sql, id: string): Promise<void>
export async function newestRequestShape(sql, seat: 'driver' | 'reviewer' | 'front_desk'): Promise<Record<string, unknown> | null>
export async function ensureOpsConversation(sql): Promise<string>   // newest conversation for OPS_USER_ID, or a new one
// monitor/drift.ts
export const OPS_USER_ID = '00000000-0000-4000-8000-00000000000f'
export type CanarySeat = 'driver' | 'reviewer' | 'front_desk' | 'scout'
export function outputBand(outputTokens: number): Band          // <=50 xs, <=200 s, <=800 m, <=3000 l, else xl
export function fingerprint(seat: CanarySeat, result: ModelResult): Omit<CanaryRun, 'requestId'>
export function diffCanary(prev: CanaryRun | null, cur: CanaryRun): Record<string, unknown> | null
export function reduceShape(req: Record<string, unknown>): Record<string, unknown>   // drop messages; tools → names; keep everything else, cache TTLs included
export function goldenArgs(seat: CanarySeat): CallArgs
export async function runDriftMonitor(deps: { sql; transport; limits; now; notifier }): Promise<{ alarms: DriftAlarm[]; runs: CanaryRun[] }>
```

- [ ] **Step 1: Failing tests** (`test/drift.test.ts`) — pure: `outputBand` boundaries; `fingerprint` for each seat (driver → tool name of the first `tool_use` or `'text'`; reviewer → `approved:true|false/issues:N` parsed from the JSON text; front_desk → the label; scout → `''`); `diffCanary` returns null on identical, a detail on a model/stopReason/signal change, null on a one-band move, a detail on a two-band move; `reduceShape` drops `messages`, maps `tools` to names, keeps `system[0].cache_control.ttl`, and differs when a TTL changes. DB: `runDriftMonitor` with a stub transport returning fixed responses — first run records four canary rows and zero alarms (no previous); second run with a changed driver tool name records one alarm `check: 'canary'`, calls `notifier.alarm` once, stamps `notified_at`; the ops conversation exists for `OPS_USER_ID` and its spend equals the summed canary costs; no traveller conversation changed; a seeded `model_calls` row for `driver` whose `request_shape` has `max_tokens` off by one produces a `shape` alarm, and one equal to `reduceShape(buildRequest(goldenArgs('driver')))` produces none; a notifier that throws leaves the alarm row with `notified_at` null and the run completes. Break: remove `distinct on`/order in `previousCanaryRun` → the "second run" test fails; return `null` from `diffCanary` always → fails.

- [ ] **Step 2: Implement** — `goldenArgs`: driver = `SEATS.driver`, `toolsForDesk('planning')`, system = the driver prompt file, one user message `'A week in Portugal in September for two adults, under 1500 euros. Start by searching flights from Berlin.'`; reviewer = `SEATS.reviewer`, `REVIEW_SCHEMA`, a fixed two-item offer text (import `renderOfferForReview` with two hand-built items); front_desk = `SEATS.front_desk`, `FRONT_SCHEMA`, `'a week in Portugal in September for two'`; scout = `SEATS.scout`, `[WEB_SEARCH_TOOL]`, `'City: Faro'`. Each canary call charges `OPS_USER_ID` via `reserve`/`reconcile` on the ops conversation and records a `model_calls` row with `conversationId` = ops conversation, `turnId: null`, `seat` = the seat (the constraint allows all four). The `monitor` seat is NOT used for the calls themselves (they are the seats under test); record the runner's own overhead nowhere — it makes no other calls. Netlify function: like `sweep.mts`, `loadEnv`, build the SDK transport as `test/driver.live.test.ts` does, `runDriftMonitor`, return JSON counts; `netlify.toml` gains `[functions."drift-monitor"] schedule = "0 3 * * *"`. Live pins: add to `test/driver.live.test.ts` one call per Haiku seat (`front_desk` with `FRONT_SCHEMA`, `scout` with `WEB_SEARCH_TOOL`) asserting `kind === 'ok'` and, for the scout, `usage.server_tool_use.web_search_requests >= 0` — this is where "no thinking block on Haiku" and the server tool shape are proven against the real API. Run them once with `LIVE_MODEL=1`; put request ids in the commit body.

- [ ] **Step 3: Commit** — `feat(monitor): drift monitor — per-seat canary fingerprints, request-shape diff, ops-charged, nightly`.

---

### Task 10: CI

**Files:**
- Create: `.github/workflows/test.yml`, `supabase/ci-bootstrap.sql`, `scripts/ci-migrate.sh`
- Modify: `package.json` (`"ci:migrate": "bash scripts/ci-migrate.sh"`), `docs/work-log.md` one line under Careful (CI's database is a container, not Supabase)

- [ ] **Step 1: Bootstrap and migrate script**

```sql
-- supabase/ci-bootstrap.sql — what a bare Postgres lacks that the migrations assume.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
```

```bash
#!/usr/bin/env bash
# scripts/ci-migrate.sh — apply bootstrap + every migration in name order to $DATABASE_URL.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/ci-bootstrap.sql
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "applying $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

- [ ] **Step 2: Workflow**

```yaml
# .github/workflows/test.yml
name: test
on:
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: ci, POSTGRES_PASSWORD: ci, POSTGRES_DB: globetrotty }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U ci" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://ci:ci@localhost:5432/globetrotty
      SUPABASE_URL: http://localhost
      SUPABASE_ANON_KEY: placeholder
      SUPABASE_SERVICE_ROLE_KEY: placeholder
      WORKER_SHARED_SECRET: placeholder
      SITE_URL: http://localhost
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      GOOGLE_SEARCH_API: ${{ secrets.GOOGLE_SEARCH_API }}
      LIVE_MODEL: '1'
      LIVE_SUPPLIERS: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: sudo apt-get update && sudo apt-get install -y postgresql-client
      - run: pnpm ci:migrate
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

Check `src/env.ts`'s `KEYS` and `test/env.test.ts`: every required key must be set to a placeholder in the workflow env, and the live tests' guard (`key.startsWith('placeholder')` → throw) means the secrets must be real for the live suite. Check `test/setup.ts` loads `.env.local` with `dotenv` — absent in CI, so the env block above is the only source.

- [ ] **Step 3: Local proof** — if Docker is available: `docker run -d --name gt-ci -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=globetrotty -p 55432:5432 postgres:16`, then `DATABASE_URL=postgres://ci:ci@localhost:55432/globetrotty pnpm ci:migrate` and `DATABASE_URL=... pnpm test` (without `LIVE_*`). All DB tests must pass against the container. Remove the container. If Docker is not available, say so in the report; the PR run is the proof.

- [ ] **Step 4: Commit** — `ci: first pipeline — Postgres service, migrations from zero, live suites on PR`. The controller pushes the branch and opens the PR; the workflow's first green run is this task's acceptance.

---

### Task 11: Records

**Files:** `docs/superpowers/2026-09-13-plan-3c-seats-decisions.md` (create), `docs/superpowers/specs/2026-09-13-plan-3c-seats-design.md` (corrections), `docs/backlog-plan.md`, `docs/work-log.md`.

- [ ] Decisions doc in the 3b format: every ledger `Ruling:`, the four plan-header deviations, the Haiku `thinking` omission (Task 3), `maskUntrustedText`'s cap option (Task 7), parked residuals.
- [ ] Backlog: `titler` seat unused; parallel scouts; `check_transfers`; scout shape drift invisible; CI roles differ from Supabase's (plan 4's RLS policies need a Supabase-shaped run); `run-turn-background.mts` still on `echoAgent` (plan 4); web search cost per scout; the canary's golden prompts must change when a seat's prompt version changes (or the first run after is a false alarm).
- [ ] Work log: 3c → merged; 4 → next; What the last session did; Careful: new conversations start at `desk='front'`, the router reads it per step; Haiku seats send no `thinking`; the monitor charges `OPS_USER_ID` and needs the ops conversation; CI secrets to add.
- [ ] Commit `docs: plan 3c decisions, backlog, work log`.

---

## Self-review

**Spec coverage.** §0 → Task 0. §1 front desk (in-turn, desk default, labels, faq park, new_trip continue + title, fallback, front_label, continue step, ceiling) → Tasks 1–4. §2 scouts (worker door, web search capped at 3, 300 words, redactor, fee, reservation, fencing) → Tasks 5–7. §3 notice → Task 8. §4 monitor (two checks, tables, alarm port, ops user, nightly function, cheap-seat ruling) → Tasks 1, 9. §5 CI → Task 10. §6 testing → each task's break steps; live pins in Task 9. §7 rulings → Task 11. Gap found and closed while planning: Haiku seats cannot receive `thinking: adaptive` — Task 3 changes `buildRequest`, Task 6 pins it, Task 9 proves it live.

**Placeholders.** Task 8 step 1, Task 9 step 1 and Task 11 describe tests and prose rather than full code; each names the exact assertions, the seeding source, and the break. Task 4's spend constant is derived in the text.

**Type consistency.** `FrontLabel` (Task 3) is what `routeToPlanning`/`recordFrontLabel` (Task 3) and migration 0015's check (Task 1) agree on. `AgentStep.continue` (Task 2) is what `makeFrontDesk` returns (Task 3) and `routeAgent` passes through (Task 4). `estimateMicros(seat, tokens, extra)` (Task 6) is what `researchDestination` calls (Task 7). `Notifier.alarm` (Task 9) is implemented by `LogNotifier`, whose `notify` is unchanged; every `makeDriver` call site already passes a `LogNotifier`. `CanarySeat` excludes `monitor`/`titler`/`sim_user`, matching migration 0015's check.
