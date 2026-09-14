# Work log

Last updated: **2026-09-14**. Written to be picked up cold after a break.

---

## Where we stand

| Plan | Contents | State |
|---|---|---|
| 1 | Durable turn harness — claim with fencing token, heartbeat lease, sweeper, spend ledger | Merged |
| 2 | Supplier port (mock + Kiwi + SearchApi), provenance corpus, seven deterministic gates | Merged |
| Tier 0 | `withHeartbeat` around tool execution; SDK error classifier | Merged |
| 3 | Model client, seven seats, prompt caching, reserve/reconcile, tool assembly, planning-desk driver | Merged |
| **Pre-3b clearance** | Migrations 0011–0013; cashier and drift-monitor blockers cleared | Merged 2026-08-30 |
| 3b | Reviewer seat, `revise_component`, the cashier (`hand_off_to_booking`), `escalate_to_human` | Merged |
| 3c | Front desk, scouts, drift monitor, CI, `trimForContext`'s price half | **On branch `feat/plan-3c-seats`, ready to merge; CI unproven until the first PR run** |
| 4 | Chat UI (Next.js), forced RLS with real policies | **Not started — next** |

**793 tests passing** (11 live external-API tests gated, including the two new L1 front-desk/scout
pins). Typecheck and lint clean. Migrations 0001–0015 applied to the live Supabase project.

**The system has made real model calls.** `LIVE_MODEL=1 pnpm demo` runs one driver turn against the live API; the conversation spend delta matched `model_calls.cost_micros` to the micro ($0.030420 both sides).

**Nothing has ever been deployed.** See *Not built yet* below — this is the biggest gap and it is larger than it looks.

---

## What the last session did

Built plan 3c — the seats half — on branch `feat/plan-3c-seats`, 12 tasks (0–11), each reviewed
individually plus a whole-branch final review. Full rulings and rationale are in
`superpowers/2026-09-13-plan-3c-seats-decisions.md`; this is the short version.

- **Migration 0015** sets `conversations.desk` default to `'front'` (existing rows keep
  `'planning'`), adds `conversations.front_label`, and creates `canary_runs`/`drift_alarms` for the
  drift monitor.
- **The front desk** (`src/agents/frontDesk.ts`, `prompts/front_desk.md`) — Haiku, structured
  output (`label`/`answer`/`title`), routes to planning on any doubt (refusal, truncation, parse
  failure, a `faq` with no answer, a `new_trip` with no title). A `faq` parks the turn
  (`awaiting_user`); a `new_trip` (or a fallback) writes the title and desk, then returns a
  `continue` step so the SAME turn falls straight into the driver — she never waits twice.
- **`routeAgent`** (`src/agents/route.ts`) reads `conversations.desk` per step and dispatches to
  the front desk or the driver; the worker's `AgentStep` gains a `continue` variant and a loop
  branch for it.
- **Scouts — `research_destination`** (`src/agents/scout.ts`) — one Haiku call with the API's
  server-side web search (`web_search_20250305`, not the plan's originally-specified
  `web_search_20260209` — Haiku 4.5 rejects that variant), capped at 3 searches, redacted
  (`redactPrices`), cut at 300 words (`cutAtWords`), fenced (worker door), charged including a
  per-search result-token allowance, carrying the traveller's notebook as prompt suffix.
- **The expired-results notice** (`src/agents/driver.ts`) — the price half of `trimForContext`, as
  a suffix warning listing stale ids rather than a rewrite of persisted transcript blocks (history
  edits break caching); the freshness gate still holds the actual guarantee.
- **The drift monitor** (`src/monitor/drift.ts`, `netlify/functions/drift-monitor.mts`) — a nightly
  canary (one golden call per seat, fingerprinted and diffed) plus a request-shape diff for the
  three full-capture seats, charged to a fixed `OPS_USER_ID`, authorised by either a shared secret
  or Netlify's own scheduled-invocation payload, era-keyed against version bumps, deduped 7 days,
  and skipping a seat canaried within the last 20 hours.
- **CI** (`.github/workflows/test.yml`) — the repo's first pipeline: a `postgres:16` service,
  migrations applied from zero, `LIVE_MODEL=1 LIVE_SUPPLIERS=1 pnpm test` on a PR to `main`.
- **Two 3b one-liners** (`src/tools/escalate.ts`, `src/sweeper.ts`) from 3b's final review, each
  with a discriminating test.
- **Six final-review fixes**, all money- or safety-adjacent: `driver@3` (the prompt file changed
  under `driver@2`); the shape check keyed to the seat's current era plus 7-day alarm dedupe;
  `maskControlChars` maps newlines to a space instead of `'?'`; a new `maskIdChars` for
  supplier-origin ids rendered as an identifier list; `releaseForContinuation` now carries the
  turn's already-self-debited spend; the monitor skips (rather than re-runs) a seat canaried
  within 20 hours, for idempotence under at-least-once scheduling.
- One thing is recorded, not fixed by this plan: **the Anthropic key's credit balance is too low**
  — every `LIVE_MODEL=1` run fails with a 400 billing error, so the L1 live pins (front desk,
  scout) are code-complete but unverified live, and CI's live suites cannot succeed on the first
  PR run until the account is topped up.

**793 tests passing, 11 skipped** (live external-API, gated) at merge — up from 650/9 at the last
update.

---

## Next steps, in order

1. **Top up the Anthropic account's credit balance.** Every live call currently 400s with "credit
   balance is too low" — this blocks the L1 live pins, CI's live suites, and the nightly drift
   monitor in production alike.
2. **Add the two repo secrets** (`ANTHROPIC_API_KEY`, `GOOGLE_SEARCH_API`) so CI can run.
3. **Open the PR for `feat/plan-3c-seats` and merge once green.** Task 10's own acceptance
   criterion — the workflow running green on the PR that adds it — has not happened yet.
4. **Plan 4** — chat UI, Next.js, forced RLS with real policies. Its route handler calls
   `decideProposal` from her accept/reject button — the cashier stays unreachable in production
   until then (backlog 3b.8). Wire `routeAgent` into `run-turn-background.mts`, replacing
   `echoAgent` (backlog 3c.6). Completes spec slice 1.
5. **Slice 2** — golden trips, simulated user, trajectory checks, calibrated judges (spec §12).

---

## Read these first

- **[Lessons: plan 1](lessons-learned-plan-1.md)** — the harness. Build against a fake model first; the harness assigns provenance; persist then schedule; fence every post-claim write.
- **[Lessons: plan 2](lessons-learned-plan-2.md)** — the trust boundary. The model proposes references, never values; a gate rehydrates every field.
- **[Lessons: plan 3](lessons-learned-plan-3.md)** — the model client. A refusal is an HTTP 200; the SDK types don't track the request surface; money invariants aren't reviewable by reading.
- **[Backlog](backlog-plan.md)** — every deferred item, triaged, each cleared one naming what cleared it.
- **[Spec](superpowers/specs/2026-08-15-globetrotty-design.md)** — binding. §5 gates/cashier, §6 data model, §7 harness/traces/drift, §8 cost control, §12 sequencing.
- Decision logs, one per plan, in `superpowers/*-decisions.md` — the rulings taken without asking, and what each costs if wrong.

---

## Careful — things that will bite in the next run

**`revise_component`-can-kill-a-turn is RESOLVED.** Plan 3b renamed `countPriorProposals` to `countPriorGateRuns`, which now counts `propose_itinerary` **and** `revise_component` calls together, excluding the current call — the collision this entry used to warn about (a `revise_component` landing at the same `round` as an earlier `propose_itinerary` in the same turn) is exactly what the rename fixes. A discriminating test (propose→revise→revise, asserting round 2) was added at Task 6's review after the brief's own check turned out structurally unable to fail. `round` still must be advanced explicitly by whoever calls either tool — the fix is in the counting, not in an automatic increment.

**The reviewer seat is safe as-is.** `'reviewer'` is in the `gate_results.gate` check constraint but deliberately *not* in `GATE_NAMES`, so a reviewer row coexists with the seven-gate set at the same round.

**`TurnState.reviewRounds` is gone.** Review rounds are no longer a persisted field anywhere on turn state — they derive from `gate_results` (`gate = 'reviewer' and turn_id = $1`), which is written before any later step and survives a crash. Two persisted counters of the same thing was one too many; do not reintroduce a field for this.

**The cashier's atomicity is two mechanisms, not one transaction.** `hand_off_to_booking` mints all `link_clicks` rows for a proposal in one transaction *inside the tool*; idempotence across a resume comes from the worker's own `tool_calls` pending row, not from that transaction spanning `finishToolCall`. A crash between the mint commit and `finishToolCall` fails the turn `fenced` (the resumed turn finds `pending`, reports `ambiguous`); the links are already committed and readable by `proposal_id`. This is a plan-recorded deviation from the parent spec's §5.6 ("after link emission nothing may mark the turn failed") — see the plan-3b decisions doc.

**`conversations.status = 'escalated'` is sticky in `completeTurn`/`failTurn`, but NOT in the sweeper.** The worker's own turn-closing paths now leave an escalated conversation's status alone. `sweeper.ts`'s crash-loop reap was not touched by this plan and still overwrites it to `'failed'` unconditionally — backlog 3b.6.

**`hand_off_to_booking` counts as one supplier call against the per-turn budget**, regardless of how many items it re-quotes. It was a code door making N supplier calls with no budget check at all until Task 8's review added it to `SUPPLIER_DOORS`; exact per-quote counting is deferred (backlog).

**`request_shape` must stay `Record<string, unknown>`.** It was `unknown`, which accepted `undefined`; `JSON.stringify(undefined)` then threw inside `recordModelCall`'s own try/catch, **swallowing the error and writing no ledger row at all**. `front_desk` and `reviewer` are both hardwired `capture_policy = 'full'`, so 3b is exactly where this would have bitten.

**The drift canary used to only run when a human remembered — RESOLVED by 3c.** The 11 live tests remain gated behind `LIVE_MODEL=1` / `LIVE_SUPPLIERS=1` (`response.model` echoes the alias for aliased models, so string comparison detects nothing and these tests are the CI-side detector), but there is now both a CI pipeline that runs them on every PR (Task 10) and a nightly production-side drift monitor (Task 9, `src/monitor/drift.ts`) that fingerprints and diffs a golden call per seat independently of any human remembering. Neither has actually run live yet — see 3c.17 in the backlog: the Anthropic key's credit balance is too low.

**The DB tests write real rows to the production Supabase project.** CI needs a non-production `DATABASE_URL`.

**CI's database is a container, not Supabase.** `.github/workflows/test.yml` runs a bare `postgres:16` service and `scripts/ci-migrate.sh` applies `supabase/ci-bootstrap.sql` (creates the `anon`/`authenticated` roles the migrations assume) then every migration in name order — there is no Supabase project behind CI, so anything relying on Supabase-specific behavior beyond plain Postgres will not be exercised there.

**Three functions move money** — `recordSpend`, `reserve`, `reconcile`. `completeTurn`/`failTurn` write `turns.spend_usd_micros`, a different column on a different table. A previous plan shipped three double-charges through three unrelated doors; **money invariants here are not reviewable by reading.**

**Two recurring defect classes, both still live:**
- *Tests that pass against the wrong implementation* — nine instances. Writing the rule down has never prevented it. Break the constraint, watch the test fail, revert.
- *Confident wrong comments on contracts* — eighteen instances. **Several originated in plan prose, pasted verbatim into comments by implementers.** Plan prose is not reviewed the way code is. Verify a claim before writing it into a plan.

**One writer per file.** Not "one implementer" — a reviewer authorised to mutate the tree to prove discrimination is a writer too. Three near-miss races across two plans, all survived on subagent discipline rather than process.

**New conversations start at `desk = 'front'`, and the router reads it per step.** `routeAgent` (`src/agents/route.ts`) checks `conversations.desk` at the START of every step, not once per turn — a conversation can move from `'front'` to `'planning'` mid-turn (the front desk's `continue` step) and the very next step's route call sees the new value. Existing (pre-migration-0015) conversations keep `desk = 'planning'` and are never re-triaged.

**Haiku seats send no `thinking` block.** `buildRequest` omits `thinking` entirely when `seat.effort === null` (`front_desk`, `scout`) — sending even an empty/default one 400s, since only Opus/Sonnet seats with a configured `effort` can receive `thinking: { type: 'adaptive' }` at all.

**The driver prompt is `driver@2`. `driver@3`.** Bumped at the final review (F1) because Task 7 added a Scouts section to `driver.md` — a prompt file edit is a version bump, always, and the plan's own Global Constraints froze the version too early. Any future prompt edit is another bump; do not edit a prompt file and reuse its pinned version string anywhere.

**The drift monitor charges `OPS_USER_ID`, on a conversation scoped to the calendar month (`title = 'ops:YYYY-MM'`), and is authorised by EITHER a shared secret OR the scheduler's own payload.** `netlify/functions/drift-monitor.mts` accepts an `x-worker-secret` header (same check as `run-turn-background.mts`) or a request body shaped `{ next_run: "<ISO-8601>" }` — Netlify's own documented scheduled-invocation marker, since a cron trigger cannot attach a custom header. **Never remove the `[functions."drift-monitor"]` `schedule` entry from `netlify.toml`** — the second auth path is safe only because Netlify does not expose scheduled functions over a plain URL ("You can't invoke scheduled functions directly with a URL"); deleting the schedule entry would turn this into an unauthenticated, uncapped-spend endpoint.

**`research_destination` counts against the per-turn supplier budget.** It is in `SUPPLIER_DOORS` alongside `hand_off_to_booking` — one scout call, regardless of how many web searches it makes internally (up to 3), counts as one supplier call.

**`releaseForContinuation` now carries the run's spend.** Fixed at the final review (F5): a turn hitting `continue_later` (reachable on every first turn now that the front desk's `continue` step exists) used to silently drop whatever it had already self-debited mid-turn from `turns.spend_usd_micros`. `runTurn` passes `turnSpend.total` and resets it to `0n` right after — the same micros must never be folded in twice across the re-invocation this triggers.

---

## What 4 needs

- **Its route handler calls `decideProposal`** (`src/repo/proposals.ts`) from her accept/reject button — this is the production caller `hand_off_to_booking`'s precondition needs; until it exists, the cashier is unreachable outside a demo or a test (backlog 3b.8).
- **Wire `routeAgent` into `run-turn-background.mts`, replacing `echoAgent`.** The front-desk/driver router built in 3c (`src/agents/route.ts`) is the real production agent; the entry point still calls the plan-1 echo stand-in (backlog 3c.6). Needs the same transport/supplier wiring `scripts/demo.ts`'s `liveDriverScenario` already shows the shape of.
- **The route calls `decideProposal`** for her accept/reject button — same item as above, restated: this is the one missing production caller across both the cashier and the front-desk-routed driver path.
- **Forced RLS is not just "add policies".** `0003_lockdown.sql` carries a written warning: the global daily ceiling sums `daily_usage.cost_micros` across **all** users. Under a per-user policy that sum silently returns only the caller's rows, reads far below the cap, and **the ceiling stops firing with no error and no failing test.** That sum must stay owner-visible or move to a maintained counter *before* any policy touches that table.
- **RLS policies must be tested against Supabase, not the CI container.** CI's `postgres:16` service only has the `anon`/`authenticated` roles the migrations assume (backlog 3c.5) — there is no real Supabase project behind it, so plan 4's forced-RLS policies need a Supabase-shaped run (staging project or equivalent) to be proven correct; CI alone will not catch an RLS regression.
- `gate_results` has no `user_id` — needs an `EXISTS` join to `conversations` under a per-user policy.
- `netlify.toml` declares `pnpm build` and `.next`; neither exists.
- **`env.ts` needs `GOOGLE_SEARCH_API`** for `run-turn-background.mts`'s real suppliers, but `loadEnv` is all-or-nothing, so adding it to the required `KEYS` list would force `sweep.mts` and `drift-monitor.mts` — neither of which touches a supplier — to also require it. Extend `env.ts` with a supplier-specific *optional* key rather than widening the required list. Backlog Tier 4.

## Known debt with a growing cost

- **`tool_results` growth is unbounded** since 0011, and **`model_calls.request_shape` is unclipped** — step N holds steps 0..N−1, one row per step, so a 24-step turn stores the transcript O(N²) times. §6 promises ≥90-day retention; **no reaper exists for either table** (verified: pg_cron not installed, no purge function). Size this before slice 2 replays traces.
