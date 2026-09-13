# Work log

Last updated: **2026-09-13**. Written to be picked up cold after a break.

---

## Where we stand

| Plan | Contents | State |
|---|---|---|
| 1 | Durable turn harness — claim with fencing token, heartbeat lease, sweeper, spend ledger | Merged |
| 2 | Supplier port (mock + Kiwi + SearchApi), provenance corpus, seven deterministic gates | Merged |
| Tier 0 | `withHeartbeat` around tool execution; SDK error classifier | Merged |
| 3 | Model client, seven seats, prompt caching, reserve/reconcile, tool assembly, planning-desk driver | Merged |
| **Pre-3b clearance** | Migrations 0011–0013; cashier and drift-monitor blockers cleared | Merged 2026-08-30 |
| 3b | Reviewer seat, `revise_component`, the cashier (`hand_off_to_booking`), `escalate_to_human` | **On branch `feat/plan-3b-gates`, ready to merge** |
| 3c | Front desk, scouts, drift monitor, CI, `trimForContext`'s price half | **Not started — next** |
| 4 | Chat UI (Next.js), forced RLS with real policies | Not started |

**650 tests passing** (9 live external-API tests gated). Typecheck and lint clean. Migrations 0001–0014 applied to the live Supabase project.

**The system has made real model calls.** `LIVE_MODEL=1 pnpm demo` runs one driver turn against the live API; the conversation spend delta matched `model_calls.cost_micros` to the micro ($0.030420 both sides).

**Nothing has ever been deployed.** See *Not built yet* below — this is the biggest gap and it is larger than it looks.

---

## What the last session did

Built plan 3b — the gates half — on branch `feat/plan-3b-gates`, 12 tasks, each reviewed
individually plus a whole-branch final review. Full rulings and rationale are in
`superpowers/2026-09-13-plan-3b-gates-decisions.md`; this is the short version.

- **Migration 0014** adds `proposals.parent_proposal_id` (revision lineage) and the `escalations`
  table, with FK indexes the brief's own SQL omitted (added because the repo-wide FK-index
  invariant test requires them).
- **`saveProposal`/`loadProposal`/`decideProposal`** (`src/repo/proposals.ts`) — nothing wrote
  `proposals` before this plan. `saveProposal` serialises the notebook through a new
  `notebookToStored` export rather than raw `sql.json`, because a budgeted notebook's `bigint`
  minor units throw on `JSON.stringify`.
- **The reviewer seat** (`src/agents/reviewer.ts`, `prompts/reviewer.md`) — Opus 5, structured
  output via a new `outputSchema` on `CallArgs`, the fourth caller of the three money doors. Every
  supplier-written field it reads is masked (`maskUntrustedText`) and fenced before it reaches the
  prompt. Round-tripping is derived from `gate_results`, not a new persisted counter —
  `TurnState.reviewRounds` is removed.
- **`revise_component`** (`src/tools/revise.ts`) — swap or shift a slot from the corpus, never a
  new supplier call, through the same gates→reviewer→save path as `propose_itinerary`. Shift now
  matches the inbound leg as well as the outbound (a review finding). `countPriorProposals` is
  renamed `countPriorGateRuns` and counts both tool names.
- **The cashier — `hand_off_to_booking`** (`src/tools/cashier.ts`) — the accept-window check,
  per-item re-quote and identity/tolerance comparison, server-built tracking URLs
  (`Supplier.bookingUrl`), and idempotent replay. A review round fixed replay ordering, widened
  `SUPPLIER_DOORS` so a hand-off counts against the per-turn supplier budget, and masked untrusted
  text in the reply.
- **`escalate_to_human`** (`src/tools/escalate.ts`, `src/notify.ts`) — fixed reason enum, 3/day
  rate limit counted fail-closed, `Notifier` port with a logging adapter, best-effort notify.
- **Driver prompt `driver@2`** — the three tools' contracts in the model's terms; `DESK_TOOLS`
  grows to eight names.
- **Four final-review fixes**, all money- or safety-adjacent: `conversations.status = 'escalated'`
  is now sticky through `completeTurn`/`failTurn`; `StoredItineraryItem` gained `bookingUrl` so the
  disclosure path (unverifiable price) can still show a real link; reviewer issue text is masked
  before it reaches the driver's own transcript; and the reviewer's spend accumulator is folded in
  a `finally`, so a throw after the reviewer call no longer drops that spend from the turn total.
- One residual is recorded, not fixed: a crash between the cashier's `link_clicks` commit and
  `finishToolCall` fails the turn `fenced` rather than the letter of parent spec §5.6 ("after link
  emission nothing may mark the turn failed") — the links are safe and recoverable by
  `proposal_id`; the fix would be a harness-wide change to how `ambiguous` resumes are handled, so
  it is a backlog item, not a fix here.

**650 tests passing, 9 skipped** (live external-API, unchanged gating) at merge — up from 534/8
at the last update.

---

## Next steps, in order

1. **Merge `feat/plan-3b-gates` to `main`.** Reviewed, tested, ready.
2. **Plan 3c** — front desk (Haiku, structured label, routes to planning on any parse failure),
   destination scouts (read-only, fenced), the drift monitor (unblocked by migration 0012; still
   needs a decision on cheap-seat sampling, backlog 2.5), CI (backlog 3.9), and `trimForContext`'s
   price half (unblocked by the cashier's re-quote path, now built).
3. **Plan 4** — chat UI, Next.js, forced RLS with real policies. Its route handler calls
   `decideProposal` from her accept/reject button — the cashier stays unreachable in production
   until then (backlog 3b.8). Completes spec slice 1.
4. **Slice 2** — golden trips, simulated user, trajectory checks, calibrated judges (spec §12).

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

**The drift canary only runs when a human remembers.** The 9 live tests are correctly gated behind `LIVE_MODEL=1` / `LIVE_SUPPLIERS=1`, but **there is no CI at all** — no `.github/workflows`. `response.model` echoes the alias for aliased models, so string comparison detects nothing and these tests are the only detector. 3c builds a drift monitor on this ground.

**The DB tests write real rows to the production Supabase project.** CI needs a non-production `DATABASE_URL`.

**Three functions move money** — `recordSpend`, `reserve`, `reconcile`. `completeTurn`/`failTurn` write `turns.spend_usd_micros`, a different column on a different table. A previous plan shipped three double-charges through three unrelated doors; **money invariants here are not reviewable by reading.**

**Two recurring defect classes, both still live:**
- *Tests that pass against the wrong implementation* — nine instances. Writing the rule down has never prevented it. Break the constraint, watch the test fail, revert.
- *Confident wrong comments on contracts* — eighteen instances. **Several originated in plan prose, pasted verbatim into comments by implementers.** Plan prose is not reviewed the way code is. Verify a claim before writing it into a plan.

**One writer per file.** Not "one implementer" — a reviewer authorised to mutate the tree to prove discrimination is a writer too. Three near-miss races across two plans, all survived on subagent discipline rather than process.

---

## What 3c needs

- **Front desk** — Haiku, structured output, fixed label set, **routes to planning on any parse failure**; never guesses, never drops.
- **Scouts** — read-only tools, no outbound channel, words never prices. Results are fenced on the way back (`worker`/`api` doors).
- **Drift monitor** — `request_shape` is now recorded, but is NULL on pre-0012 rows *and* on `'truncated'` rows (cheap seats above the byte threshold, since `request_shape` is NULL on those truncated rows by design). §7's drift sentence covers all seats; **decide whether the monitor samples cheap seats**, because there would be nothing to compare against for any cheap-seat call over the truncation threshold.
- **CI** — needs a non-production `DATABASE_URL`; the DB tests write real rows and today run against the live Supabase project. No `.github/workflows` exists yet at all (backlog 3.9).
- **`trimForContext`'s price half** — stripping prices past their supplier's `pricePersistence` window needs the re-quote path. That path now exists (plan 3b's cashier); 3c is unblocked to implement this half. Noted in `src/tools/validate.ts`.

## What 4 needs

- **Its route handler calls `decideProposal`** (`src/repo/proposals.ts`) from her accept/reject button — this is the production caller `hand_off_to_booking`'s precondition needs; until it exists, the cashier is unreachable outside a demo or a test (backlog 3b.8).
- **Forced RLS is not just "add policies".** `0003_lockdown.sql` carries a written warning: the global daily ceiling sums `daily_usage.cost_micros` across **all** users. Under a per-user policy that sum silently returns only the caller's rows, reads far below the cap, and **the ceiling stops firing with no error and no failing test.** That sum must stay owner-visible or move to a maintained counter *before* any policy touches that table.
- `gate_results` has no `user_id` — needs an `EXISTS` join to `conversations` under a per-user policy.
- `netlify.toml` declares `pnpm build` and `.next`; neither exists.
- **The production entry point still runs `echoAgent`.** Wiring the real driver needs `GOOGLE_SEARCH_API` in `env.ts`, but `loadEnv` is all-or-nothing, so adding it forces `sweep.mts` to require a supplier key. Extend `env.ts` with a supplier-specific *optional* key rather than widening the required list. Backlog Tier 4.

## Known debt with a growing cost

- **`tool_results` growth is unbounded** since 0011, and **`model_calls.request_shape` is unclipped** — step N holds steps 0..N−1, one row per step, so a 24-step turn stores the transcript O(N²) times. §6 promises ≥90-day retention; **no reaper exists for either table** (verified: pg_cron not installed, no purge function). Size this before slice 2 replays traces.
