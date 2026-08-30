# Work log

Last updated: **2026-08-30**. Written to be picked up cold after a break.

---

## Where we stand

| Plan | Contents | State |
|---|---|---|
| 1 | Durable turn harness — claim with fencing token, heartbeat lease, sweeper, spend ledger | Merged |
| 2 | Supplier port (mock + Kiwi + SearchApi), provenance corpus, seven deterministic gates | Merged |
| Tier 0 | `withHeartbeat` around tool execution; SDK error classifier | Merged |
| 3 | Model client, seven seats, prompt caching, reserve/reconcile, tool assembly, planning-desk driver | Merged |
| **Pre-3b clearance** | Migrations 0011–0013; cashier and drift-monitor blockers cleared | **Merged 2026-08-30** |
| 3b | Front desk, scouts, reviewer seat, cashier, `revise_component`, `escalate_to_human`, drift monitor | **Not started — next** |
| 4 | Chat UI (Next.js), forced RLS with real policies | Not started |

**534 tests passing** (8 live external-API tests gated). Typecheck and lint clean. Migrations 0001–0013 applied to the live Supabase project.

**The system has made real model calls.** `LIVE_MODEL=1 pnpm demo` runs one driver turn against the live API; the conversation spend delta matched `model_calls.cost_micros` to the micro ($0.030420 both sides).

**Nothing has ever been deployed.** See *Not built yet* below — this is the biggest gap and it is larger than it looks.

---

## What the last session did

Cleared six backlog items that plan 3b either cannot be built without, or that get more expensive once its seats exist.

- **Migration 0011 — `tool_results` is append-only** per spec §6. Every re-quote used to overwrite the prior price and destroy it unrecoverably. `rehydrate` now takes the newest row per `source_id`, with an `id desc` tiebreak proven load-bearing across seq/index/bitmap plans.
- **Migration 0012 — `model_calls.request_shape`.** §7 promises driver rows are a full eval corpus and that the assembled request is recorded for drift detection. Neither held: `user_prompt` repeated her opening message on every step. **Unblocks 3b's drift monitor.**
- **Migration 0013 — one `gate_results` row per `(turn_id, round, gate)`.** Keyed on the turn, not the conversation. **Read the warning in *Careful* below before building `revise_component`.**
- **`rehydrate` surfaces `search_params`** — §5's cashier re-quotes by re-running the stored search and finding by native ID. The column was written and read by nothing. **Unblocks 3b's cashier.**
- **`sourceId` sanitized at all nine untrusted interpolations** reaching the model (`checks.ts` ×8 + `rehydrateGate.ts`).
- **The global-spend day filter is pinned** by a test that discriminates; it previously passed vacuously.

---

## Next steps, in order

1. **Plan 3b** — front desk (Haiku, structured label), destination scouts, senior reviewer seat, the cashier, `revise_component`, `escalate_to_human`, drift monitor. Both hard blockers are clear.
2. **CI (backlog 3.9)** — worth doing *before or alongside* 3b, not after; see *Careful*.
3. **Plan 4** — chat UI, Next.js, forced RLS with real policies. Completes spec slice 1.
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

**`revise_component` can kill a turn.** `countPriorProposals` derives `round` by counting `propose_itinerary` calls **only**. A `revise_component` that re-runs the gates without advancing `round` collides with `gate_results_one_row_per_gate_per_round`, and `recordGateResults` is a plain multi-row insert with no `on conflict` — so the whole turn fails. Pre-0013 this was silent double-counting; now it is loud. The precondition is documented at `countPriorProposals` and in migration 0013. **Advance `round` explicitly.**

**The reviewer seat is safe as-is.** `'reviewer'` is in the `gate_results.gate` check constraint but deliberately *not* in `GATE_NAMES`, so a reviewer row coexists with the seven-gate set at the same round.

**`request_shape` must stay `Record<string, unknown>`.** It was `unknown`, which accepted `undefined`; `JSON.stringify(undefined)` then threw inside `recordModelCall`'s own try/catch, **swallowing the error and writing no ledger row at all**. `front_desk` and `reviewer` are both hardwired `capture_policy = 'full'`, so 3b is exactly where this would have bitten.

**The drift canary only runs when a human remembers.** The 8 live tests are correctly gated behind `LIVE_MODEL=1` / `LIVE_SUPPLIERS=1`, but **there is no CI at all** — no `.github/workflows`. `response.model` echoes the alias for aliased models, so string comparison detects nothing and these tests are the only detector. 3b builds a drift monitor on this ground.

**The DB tests write real rows to the production Supabase project.** CI needs a non-production `DATABASE_URL`.

**Three functions move money** — `recordSpend`, `reserve`, `reconcile`. `completeTurn`/`failTurn` write `turns.spend_usd_micros`, a different column on a different table. A previous plan shipped three double-charges through three unrelated doors; **money invariants here are not reviewable by reading.**

**Two recurring defect classes, both still live:**
- *Tests that pass against the wrong implementation* — nine instances. Writing the rule down has never prevented it. Break the constraint, watch the test fail, revert.
- *Confident wrong comments on contracts* — eighteen instances. **Several originated in plan prose, pasted verbatim into comments by implementers.** Plan prose is not reviewed the way code is. Verify a claim before writing it into a plan.

**One writer per file.** Not "one implementer" — a reviewer authorised to mutate the tree to prove discrimination is a writer too. Three near-miss races across two plans, all survived on subagent discipline rather than process.

---

## What 3b needs

- **Cashier** — `rehydrate` now returns `StoredItem.searchParams` (null when no real search was recorded, never `{}`). `SupplierCapabilities` (`live`, `mayRequote`, `maxAgeSeconds`, `pricePersistence`) already exists on the port. §5's rules: refuse without a stored `decision='accept'` within 30 minutes; compare **per item and on item identity**, not on the sum; unknown is not unchanged; build URLs server-side; link emission is the point of no return.
- **`trimForContext`'s price half is deliberately unimplemented** — stripping prices past their supplier's `pricePersistence` window needs the re-quote path, which arrives with the cashier. Noted in `src/tools/validate.ts`.
- **Drift monitor** — `request_shape` is now recorded, but is NULL on pre-0012 rows *and* on `'truncated'` rows (cheap seats above the byte threshold). §7's drift sentence covers all seats; **decide whether the monitor samples cheap seats**, because there would be nothing to compare against.
- **Front desk** — Haiku, structured output, fixed label set, **routes to planning on any parse failure**; never guesses, never drops.
- **Scouts** — read-only tools, no outbound channel, words never prices. Results are fenced on the way back (`worker`/`api` doors).

## What 4 needs

- **Forced RLS is not just "add policies".** `0003_lockdown.sql` carries a written warning: the global daily ceiling sums `daily_usage.cost_micros` across **all** users. Under a per-user policy that sum silently returns only the caller's rows, reads far below the cap, and **the ceiling stops firing with no error and no failing test.** That sum must stay owner-visible or move to a maintained counter *before* any policy touches that table.
- `gate_results` has no `user_id` — needs an `EXISTS` join to `conversations` under a per-user policy.
- `netlify.toml` declares `pnpm build` and `.next`; neither exists.
- **The production entry point still runs `echoAgent`.** Wiring the real driver needs `GOOGLE_SEARCH_API` in `env.ts`, but `loadEnv` is all-or-nothing, so adding it forces `sweep.mts` to require a supplier key. Extend `env.ts` with a supplier-specific *optional* key rather than widening the required list. Backlog Tier 4.

## Known debt with a growing cost

- **`tool_results` growth is unbounded** since 0011, and **`model_calls.request_shape` is unclipped** — step N holds steps 0..N−1, one row per step, so a 24-step turn stores the transcript O(N²) times. §6 promises ≥90-day retention; **no reaper exists for either table** (verified: pg_cron not installed, no purge function). Size this before slice 2 replays traces.
