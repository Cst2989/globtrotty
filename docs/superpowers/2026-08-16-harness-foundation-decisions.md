# Harness Foundation — decisions taken during execution

Every ruling made while executing `docs/superpowers/plans/2026-08-15-harness-foundation.md`.
Recorded because these were decisions taken on the author's behalf, without asking, so the
work could continue. Each says what was decided, why, and what it costs if it was wrong.

Branch: `feat/harness-foundation` · 31 commits · 102 tests · 12 tasks, each reviewed
individually, then a whole-branch review that found 3 Critical seam defects no single-task
review could see.

---

- Ruling: Use the hosted Supabase project over local Docker — user instruction; Docker daemon
- Ruling: Connect via the **direct** host (`db.<ref>.supabase.co:5432`, IPv6) rather than the
- Ruling: Relax the plan's "Node 22+" global constraint to **Node 20+** — installed runtime is
- Task 1: Ruling: finding "postgres in devDependencies" is VALID — Task 12 opens it at runtime in
- Task 1: Ruling: finding "fabricated justification in the report" is REJECTED as characterised.
- Task 2: Ruling: finding 1 (unbranded `Money` permits bypassing `money()` validation) is VALID
- Task 3: Ruling: on a patch mixing valid and unrecognised keys, the whole patch is rejected and
- Ruling: `pnpm-lock.yaml` is untracked and must be committed for reproducible installs — the
- Task 3: Ruling: Important 1 (a non-user source may ESTABLISH a constraint that was never set)
- Task 3: Ruling: Important 2 (destination/dates carry no relax-guard, so tool-sourced text can
- Ruling: the plan's `test/helpers/db.ts` uses `describe` without importing it from vitest —
- Ruling: nothing in the plan loads `.env.local` into `process.env`, so every DB test would
- Ruling: migrations apply to the hosted project via `supabase db push` (project is linked);
- Ruling: acceptable. The target is our own dev project, the SQL was authored in this repo and
- Task 4: Ruling: Minor — `model_calls` carries no FK on conversation_id/turn_id, in tension with
- Task 4: Ruling: Minor — `tool_calls` has no owner column. Accepted: it is reachable only via
- Task 4: Ruling: Minor — `supabase/.gitignore` committed unrequested. Accepted: standard
- Task 5: Ruling: Important (precedence only partially pinned) is VALID and worth fixing now.
- Task 7: Ruling: Important (the fenced test proves "it threw", not "nothing partial survived")
- Task 8: Ruling: accept the implementer's choice (the stated per-model interface). Per-model
- Task 8: Ruling: Important (the 10-concurrent-increments test does not exercise concurrency —
- Task 9: Ruling: Important (finishToolCall does not verify it updated a row) is VALID and worth
- Task 10: Ruling: Important #1 (staleness predicate duplicated between the count query and the
- Task 10: Ruling: Important #2 (turns_sweeper index cannot serve as a scan key) is a SCHEMA
- Task 11: Ruling: Minor 1 (`sql: any` in test/handler.test.ts, inherited verbatim from my brief)
- Task 11: Ruling: Minor 2 (`SubmitDeps.now` accepted and never used) — REMOVING it. The reviewer
- Task 12: Ruling: (b) non-constant-time secret comparison — FIXING NOW. One line, and it is on
- Task 12: Ruling: (a) LIMITS duplicated as a bare literal in the background function — FIXING
- Task 12: Ruling: (c) Netlify functions carry untested logic (auth, body validation, postgres
- Task 12: Ruling: implementer asked whether test/engine.test.ts should also import DEFAULT_LIMITS.
- Ruling: all three fixed in ONE wave per the process (one fix dispatch, one scoped re-review).
- Ruling: `step.run()` — the actual side-effecting tool execution — is NOT wrapped by

## Carried forward

- Task 3: CARRY TO PLAN 2 — the harness, never the model, assigns provenance. If `update_requirements`
- wrong: an orphaned conversation_id cannot be validated at write time. CARRY TO PLAN 4: the
- CARRY TO PLAN 4: consider a pooled-connection integration test for the worker path.
- Task 8: CARRY TO PLAN 4 (merged with the Task 7 entry): one pooled-connection integration test
- Task 11: CARRY TO PLAN 4 (observability): a failed `invoke` is swallowed with no logging. The
- cannot be unit-tested in this harness. CARRY TO PLAN 4: staging validation before deploy,
- *** REQUIRED FOR PLAN 3: wrap step.run() in withHeartbeat (a one-line application of the

## Deferred minors

- Task 1: minor (deferred): report's lock-file rationale cites gitignore; actual reason is the
- Task 1: minor (deferred): TDD red-first step not evidenced in the report (unverifiable from a diff).
- Task 1: minor (deferred): vitest needs @rolldown/binding-darwin-arm64 on first install — note for CI.
- Task 2: minor (deferred): formatMoney converts bigint via Number for display; precision loss
- Task 2: minor (deferred): EUR formatMoney assertion uses toContain('1,412'), narrower than ideal.
- Task 2: minor (deferred): KWD format assertion uses contains('141.2'); it does distinguish
- Task 3: minor (deferred): `rejected` does not distinguish "malformed" from "relaxation refused";
