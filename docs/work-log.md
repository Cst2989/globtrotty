# Work log

Last updated: **2026-09-19**. Written to be picked up cold after a break.

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
| 3c | Front desk, scouts, drift monitor, CI, `trimForContext`'s price half | Merged 2026-09-14; CI still unproven until the first PR run |
| **4a** | Next.js chat on Netlify, magic-link sign-in, RLS policies, the operator channel, the proposal card, the outbound filter, deploy | **On branch `feat/plan-4-chat`, ready to merge — deployed to https://globtrotty.netlify.app** |
| 4b | Token streaming with the redactor on deltas, GDPR export/delete, memory across conversations, shift-dates UI beyond ±2, account management | Not started — next (spec 4a's own "Out" line) |

**991 tests passing, 13 skipped** (live external-API and `LIVE_SUPABASE` suites, gated). Typecheck
clean across all three passes, lint clean with `.netlify/` present, `pnpm build` clean. Migrations
0001–**0017** applied to the live Supabase project.

**The system has made real model calls.** `LIVE_MODEL=1 pnpm demo` runs one driver turn against the live API; the conversation spend delta matched `model_calls.cost_micros` to the micro ($0.030420 both sides).

**It is deployed.** https://globtrotty.netlify.app — the Next.js app, its `/api/*` routes, the
`proxy.ts` edge handler, and three Netlify functions (`run-turn-background`, `sweep`,
`drift-monitor`). Deploys are Netlify CLI only (`netlify deploy --build --prod`), by hand, from a
machine with `.env.local`; the runbook is **[docs/deploy.md](deploy.md)**. Two things are still
open on the deploy: `supabase config push` has not been run (the auth redirect URLs in
`supabase/config.toml` may not match the live project, which makes a magic link fall back to the
stored `site_url`), and the **sign-in smoke has not been done** — nobody has yet signed in on the
deployed site and watched a turn run. Both are user actions; see Next steps.

---

## What the last session did

Built plan 4a — the chat — on branch `feat/plan-4-chat`, 11 tasks, each reviewed individually
(seven took one fix round) plus a whole-branch final review and one fix wave. Full rulings and
rationale are in `superpowers/2026-09-19-plan-4-chat-decisions.md`; this is the short version.

- **Migration 0016** widens `messages.role` to `user | agent | action` and `agent_events.kind` with
  `'screened'`, adds `conversations`/`messages` to the `supabase_realtime` publication, and grants
  `authenticated` **select only** on the nine user-owned tables with per-user policies.
  **Migration 0017** narrows the `agent_events` policy to `kind <> 'screened'`.
- **The operator channel.** Button presses are never user text: they are `messages.role = 'action'`
  JSON rows, written only by route handlers, hydrated by `loop()` into mid-conversation `system`
  messages whose wording is built server-side from fixed fragments plus a uuid and an enum. The
  payload is a `z.strictObject` discriminated union; `rejected` carries no `reason` at all (her
  reason is written as her own `role='user'` message in the same transaction).
- **The Next.js app** (`app/`, `web/`, `proxy.ts`, `next.config.ts`) — magic-link sign-in, thread,
  sidebar, status line, message box, and the proposal card with Accept / Reject / per-item swap /
  shift ±2. Reads go through Supabase RLS on her cookie; writes go through the existing repo
  functions on the owner connection in route handlers, with `user_id` from the verified session and
  an explicit ownership select per write.
- **The outbound solicitation filter** (`screenOutbound`, `src/sanitize.ts`) — a 20-rule
  deterministic table applied to every model-authored outbound string in both the `message` and
  `park` branches. A hit replaces the reply, writes the original to `agent_events`
  (`kind: 'screened'`), and pages a human through `recordEscalation` — **never** rate-limited
  against the driver's daily escalation budget.
- **The production agent.** `run-turn-background.mts` now builds the real `routeAgent` with the SDK
  transport, `KiwiSupplier` and `SearchApiHotels`, replacing `echoAgent` (backlog 3c.6, cleared).
  Prompt files are loaded through `loadPrompt`, which survives esbuild bundling.
- **Deploy** — site created and linked, every env name pushed (secrets context-scoped), the Next
  plugin and `included_files` in `netlify.toml`, and `docs/deploy.md`.
- **One Critical from the final review, fixed:** `buildRequest` ran `normalizeOperatorTurns` before
  `withSuffix`, so on the accept path the operator instruction landed two turns from the end of the
  request, ahead of the assistant message presenting the very proposal it referred to. The ruling
  had said "after the suffix"; the build did the opposite and no test caught it, because the one
  test covering that transcript used an empty suffix. Also fixed in the wave: the screened-original
  policy hole (0017), `.netlify/**` breaking `pnpm lint`, the non-planning desk 500ing instead of
  409ing, a stale `SwapPicker` selection that could post a no-op swap, and the card's 429 copy.
- **The `route.test.ts` flake, reported three times, is understood and fixed in the assertion:**
  `withTestDb` runs the whole test in one transaction, so `now()` is frozen and rows tie on
  `created_at`. `order by created_at` over a tie has no guaranteed order.

**991 tests passing, 13 skipped** at merge — up from 793/11 at the last update.

---

## Next steps, in order

1. **Run `supabase config push`** (or set the two URLs in the dashboard: Authentication → URL
   Configuration). Read the diff before answering `y` — it pushes the whole `[auth]` section.
   `supabase/config.toml` is the source of truth and was aligned with the live project first, so
   the diff should be only `site_url` and `additional_redirect_urls`. Until this runs, a magic link
   silently falls back to the project's stored `site_url`.
2. **Do the sign-in smoke** on https://globtrotty.netlify.app: sign in by magic link, send "a week
   in Portugal in September for two", watch `conversations.status` go `working` →
   (`awaiting_user` | `failed`). With no Anthropic credit the turn fails `provider_rejected` /
   `provider_down` with the reason shown in the status line — that still proves the chain end to end.
3. **Top up the Anthropic account's credit balance.** Still blocking, now for a fourth thing: the
   live operator-channel pin (backlog 4a.14), the L1 front-desk/scout pins, CI's live suites, and
   the nightly drift monitor in production. The operator pin is the one to run first — it is the
   only check on the transcript shape the accept path now sends.
4. **Add the two repo secrets** (`ANTHROPIC_API_KEY`, `GOOGLE_SEARCH_API`) so CI can run, open the
   PR for `feat/plan-3c-seats`'s successor work and merge once green. CI's own acceptance criterion
   — the workflow running green on a PR — still has not happened.
5. **Merge `feat/plan-4-chat`.**
6. **Plan 4b** — token streaming with the price redactor applied to deltas, GDPR export/delete,
   memory across conversations, shift-dates UI beyond ±2, account management (spec 4a's own "Out"
   line). Completes spec slice 1.
7. **Slice 2** — golden trips, simulated user, trajectory checks, calibrated judges (spec §12).

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

**`messages.role = 'action'` rows ARE the operator channel — they are never her words, and never agent text.** Written only by the three route handlers, `content` is a `z.strictObject` JSON payload (`hand_off` | `rejected` | `revise`, a uuid, an enum, nothing free-form), and `loop()` hydrates each one into a `LoopMessage { role: 'system' }` whose sentence is built server-side from fixed fragments — never the JSON verbatim, never `role: 'user'`, and a malformed row hydrates to a fixed "could not be read" line rather than falling back. The UI is symmetric: `web/data.ts`'s `toThreadView` turns the row into its `describeActionForUi` sentence **server-side**, so the JSON and the proposal id never enter the RSC payload. `rejected` deliberately carries no `reason` field: her reason is written as an ordinary `role='user'` message inside the same transaction, stamped `now()` while the action row takes `clock_timestamp()` so it sorts first. If she *types* "accept proposal X", it is an ordinary user message and the cashier still refuses — no `decision` row exists. A test pins that.

**The transcript pipeline order is a rule, and it was already got wrong once.** `buildRequest` is `normalizeOperatorTurns(withSuffix(placeBreakpoints(messages), suffix))` — in that order, for two independent reasons. `placeBreakpoints` runs FIRST, on the raw transcript, so the volatile notebook suffix does not yet exist and can never carry the rolling cache breakpoint (a wasted cache write on every request). `normalizeOperatorTurns` runs LAST, after the suffix, so a trailing operator message stays **last** in the request — which is what spec §4 and the Task 2 ruling require and what the driver prompt ("they reach you as a message from the office naming the tool to call") assumes. Built in the opposite order, the accept path sent the model "she accepted proposal X, call `hand_off_to_booking`" *before* its own message presenting that proposal, with the notebook after it. Neither `placeBreakpoints` walk touches a `system` block wherever it sits, which is why reordering the normalise step behind it moves no breakpoint. **No live model call has ever exercised either shape** (backlog 4a.14).

**RLS is enabled with policies and MUST NEVER be forced.** The worker connects as the table owner, and `0003_lockdown.sql`'s warning is the reason: the global daily ceiling sums `daily_usage.cost_micros` across **all** users, so a policy the owner is subject to would make that sum return only the caller's rows, read far below the cap, and stop firing with no error and no failing test. `daily_usage` (and `model_calls`, `canary_runs`, `drift_alarms`, `conversions`, `tool_calls`) therefore have no grant and no policy at all. `authenticated` has `select` and nothing else on the nine user-owned tables; `anon` has nothing; every write is a route handler on the owner connection. `test/schema-4.test.ts` pins the grant list, the policy list, the six deny-all tables, the not-forced property, **and** `own_agent_events`' exact predicate text (`user_id = auth.uid() and kind <> 'screened'`, migration 0017 — a screened reply's original must not be readable by the role it was withheld from). RLS is only ever *proven* by `test/rls.live.test.ts`, gated `LIVE_SUPABASE=1`, against the real project — every other DB test runs on the owner connection, which bypasses RLS entirely, and CI is a bare Postgres container with no Supabase behind it.

**There is a deploy runbook: [docs/deploy.md](deploy.md). Read it before touching the site.** It carries the site and project ids, the env-name list with the context-scoping rule (`--secret` is refused for `dev`, so secrets are set `--context production --context deploy-preview --context branch-deploy`), the `supabase config push` caveat (it pushes the whole `[auth]` section — read the diff), the build-log checks that matter (three functions packaged, `___netlify-edge-handler-node-middleware` present — that edge handler is `proxy.ts`, and a silently missing one turns session refresh and the anonymous redirect off without failing the build), and the secret-rotation story. Deploys are CLI-only, by hand: there is no GitHub integration and no deploy preview (backlog 4a.9).

**`SITE_URL` is a different value in every environment, and three places must agree.** It is `http://localhost:3000` locally and `https://globtrotty.netlify.app` on Netlify. The functions call each other through it (`web/invoke.ts` and `src/invoke.ts` both POST to `${SITE_URL}/.netlify/functions/run-turn-background`), the CSP's `connect-src` is built from the Supabase project URL alongside it, and `supabase/config.toml`'s `site_url`/`additional_redirect_urls` must list the same origin or a magic link silently redirects to whatever the project has stored. A custom domain is those three plus a redeploy plus a config push (backlog 4a.11).

**`/.netlify/` bypasses the session proxy on purpose — and that is what the shared secret is for.** `proxy.ts`'s matcher excludes it and `decide()` treats it as public, because the first production deploy answered the background function's own URL with a `307 → /login`: the app's session guard was standing in front of a machine-to-machine endpoint that never had a session. `run-turn-background` has a real `timingSafeEqual` check on `x-worker-secret` and that is the only door on those paths. Note also that a Netlify **background** function always answers `202` regardless of what the handler returns — the real 401 is in the function log, and "202" is not evidence the secret check passed. Related and sharper: **never remove a `schedule` key from `netlify.toml`** — `sweep` has no auth check at all and `drift-monitor` accepts a forgeable `next_run` body, and both are safe only because Netlify does not expose scheduled functions over a URL (backlog 4a.13).

**`withTestDb` freezes `now()`, so rows inserted in one DB test can tie on `created_at`.** `test/helpers/db.ts` wraps the whole test in ONE transaction (a nested `sql.begin` is shimmed to a savepoint), and Postgres' `now()` is the *transaction* start time — verified directly: `now()` identical across statements in one tx, `clock_timestamp()` not. So `order by created_at` over rows written by two different calls in the same test is a total tie, and Postgres guarantees nothing about tie order: the plan flips between an index scan and an unstable sort as statistics move under full-suite load. This produced three separate "flaky test" reports across three tasks, each dismissed because it passed in isolation. **Assert order-independently (or by role), never add a secondary sort key** — `role` sorts `agent` before `user` and would pin the wrong answer. Where order genuinely matters in the product, the row gets an explicit `clock_timestamp()` (as `submitAction`'s action row does, so the reject note sorts ahead of it).

---

## What 4b needs

Plan 4a cleared every item this section used to list — the route handler that calls
`decideProposal` exists (`web/decideRoute.ts`, so `hand_off_to_booking` is finally reachable in
production), `routeAgent` is wired into `run-turn-background.mts`, RLS has real per-user policies
proven against Supabase, `gate_results`' `EXISTS` join is written, `netlify.toml` builds a real
Next app, and `env.ts` reads `GOOGLE_SEARCH_API` through `loadOptionalEnv` without widening the
required `KEYS` list. What 4b inherits instead:

- **Streaming is the hard half of 4b, and the redactor is why.** `redactPrices` and `screenOutbound`
  both read whole sentences; a price or a solicitation split across two deltas is not a sentence.
  Whatever ships must not let a raw supplier price reach her mid-stream. Separately, plan 3 already
  found that **streaming is required for large `max_tokens`** to avoid HTTP timeouts — that
  constraint applies to the API call regardless of what the UI does with it.
- **GDPR export/delete has to decide what happens to the ledgers.** Her rows span nine tables she
  can read plus `daily_usage` and `model_calls`, which she cannot — and `daily_usage` is what the
  global ceiling sums. A delete that removes those rows moves money guardrails.
- **The operator channel is the seam for any new button.** A new action is a new arm on
  `ActionPayload`, a new fixed sentence in `renderActionMessage`, a new `describeActionForUi` line,
  and a route handler that writes the row inside `submitAction`'s fresh-turn transaction. It is
  never a phrase.
- **Sign-in is magic-link only.** Account management (4b) is where email/password, sign-out and
  account deletion land. Note that `test/rls.live.test.ts` already depends on the email+password
  provider being enabled on the project for its two throwaway users (backlog 4a.10).

## Known debt with a growing cost

- **`tool_results` growth is unbounded** since 0011, and **`model_calls.request_shape` is unclipped** — step N holds steps 0..N−1, one row per step, so a 24-step turn stores the transcript O(N²) times. §6 promises ≥90-day retention; **no reaper exists for either table** (verified: pg_cron not installed, no purge function). Size this before slice 2 replays traces.
