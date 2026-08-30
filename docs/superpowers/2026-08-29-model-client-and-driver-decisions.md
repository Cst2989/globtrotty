# Model Client and Driver Loop — decisions taken during execution

Rulings made while executing `docs/superpowers/plans/2026-08-29-model-client-and-driver-loop.md`,
recorded because they were taken on the author's behalf so the work could continue. Same format
as `2026-08-16-harness-foundation-decisions.md` and `2026-08-16-supplier-port-and-gates-decisions.md`:
what was decided, why, and what it costs if it was wrong.

Branch: `feat/model-client-and-driver` · 12 tasks (1, 2, 2b, 3–11), each reviewed individually,
then a whole-branch review that returned "Merge with fixes" — 0 Critical, 6 Important, 7 Minor —
one fix wave, and one scoped re-review. 520 tests passing at merge.

**What distinguishes this plan from the previous two: I wrote it, and the pre-flight scan of my
own plan found 29 conflicts, six of them blocking.** Three of those six were money or correctness
bugs that would have shipped. The plan was revised before Task 1 rather than corrected per-task,
because the errors were architectural, not detail-level.

---

## The six blocking pre-flight rulings

### B1 — `AgentContext` had no `turnId`

**Ruling: add `turnId: string` to `AgentContext` in `src/worker.ts`, passed from `claim.turnId`.**

The driver needs it for tool-call recording and the per-turn supplier budget. Confirmed TS2353
without it — the plan as written did not compile.

**Cost if wrong:** none. One field.

### B2 — every driver model call was charged TWICE

**Ruling: `AgentStep` gains `recordedMicros` — spend the agent has already debited. The worker
adds it to `turnSpend` (so `turns.spend_usd_micros` stays right) but does NOT `recordSpend` it
again.**

The driver reserves and reconciles its own model spend per spec §8. The worker then called
`recordSpend(step.costMicros)` on top. Nothing caught it because no test ran the driver through
`runTurn` — the seam between the two halves was the one place no test looked. `costMicros` keeps
its old meaning for agents that have not debited, so `echoAgent` was untouched.

**Cost if wrong:** a double charge on every model call — the single worst bug this plan could
ship, and the reason the whole-branch review was asked to count the doors that move money.

### B3 — `tool_calls` was double-booked, so tools would never execute

**Ruling: split Task 7. The PURE half (`validateToolCall`, `fenceResult`) moves to the driver.
The DURABLE half stays where plan 1 put it: the worker's `beginToolCall`/`finishToolCall` remains
the single writer.**

`worker.ts` already called `beginToolCall`, so the planned `runTool` would have called it a second
time, seen `pending`, and returned `ambiguous` — meaning **the tool never runs.** The plan
duplicated machinery plan 1 already owned. Note this is the same mistake as B2 in a different
place: B2 duplicated the spend writer, B3 duplicated the `tool_calls` writer.

**Cost if wrong:** the desk can talk and search but never acts.

### B4 — two tools advertised with no handler

**Ruling: Task 10 gains explicit steps and tests for both.**

`update_requirements` and `propose_itinerary` are the planning desk's entire point, and `runGates`
appeared in Task 10's Interfaces block but in no step and no test.

**Cost if wrong:** the driver can search and talk but cannot plan.

### B5 — refusal-parks contradicted the spec

**Ruling: SPEC WINS. A refusal fails the turn with `fail_reason: 'refused'`.**

Spec §8 says a refused driver call "fails the turn with words she can act on and does not consume
quota". My plan parked instead. This also gives `'refused'` its first writer — Tier 0 added the
enum value and nothing wrote it.

**Cost if wrong:** a refusal reads as a normal park and the refusal rate is unmeasurable.

### B6 — cache-write undercount

**Ruling: `src/pricing.ts` gains a 1h write multiplier and `costMicros` takes the TTL.**

A 1h-TTL cache write bills at ~2× input, not the 1.25× that was hard-coded, and the system
breakpoint is 1h on every driver call.

**Cost if wrong:** undercounting a money guardrail — the one direction pricing must never err.

---

## API-drift ruling

**Ruling: all 13 API facts in the plan verified TRUE against the installed SDK types, with two
corrections folded in.**

- The prompt-cache minimum is **model-dependent** — Opus 5 is 512 tokens, not the ~1024 assumed.
  The plan's Haiku 4096 figure was right.
- **`budget_tokens` still exists in the SDK types** even though Opus 5 returns 400 for it. `tsc`
  therefore CANNOT catch that error. The shape test in Task 3 is the only guard and must stay.

**Cost if wrong:** deleting that test as redundant restores a silent 400 on every call.

---

## Rulings during execution

### Task 3 — `RefusalError`/`throwIfRefused` kept with no production caller

**Ruling: NOT deleting.** Plan 3b's reviewer seat may want the throwing form, on the principle
that a refused reviewer call must never be read as approval.

**Cost if wrong:** dead code carried forward one plan.

### Task 10 — I proposed narrowing provenance taint, and was overturned

**Ruling: the reviewer overturned me and is right. Taint-on-any-`tool_result` stays.**

I proposed narrowing the taint to untrusted doors. But `propose_itinerary` is a `code` door and
therefore NOT fenced, while its rejection text embeds supplier-derived money — *"this trip totals
EUR X, over your EUR Y budget"*. That is the exact sentence that motivates a traveller raising her
budget, so a door-based rule would stamp the following write `'user'` and **open a hole at the
money gate.**

**Cost if wrong (had I not been overturned):** fabricated prices could establish a budget that the
money gate then treats as traveller-stated.

### Task 10 — deferred Minor: `provenanceFor` never returns `'tool'`

**Ruling: deferred to the whole-branch review, then carried to the backlog.**

`notebook.ts` retains a comment describing a `'tool'` branch that cannot be reached. Not a gate
bypass: with no budget the gate records `noBudget` and evaluates nothing, so a fabricated budget
can only reject *more*, never less. The fix only tightens.

**Cost if wrong:** after a search, a budget she genuinely stated in the same message cannot be
recorded that turn.

---

## Process rulings

### One implementer at a time — a rule I wrote and then broke twice

**Ruling recorded mid-plan: reviews may run in parallel with an implementer; a SECOND implementer,
including any fix round, may not.**

Two git races occurred before the rule was held. Both agents recovered non-destructively, and one
correctly refused to touch another task's work-in-progress and flagged it instead — *that was its
discipline, not my design.* With overlapping files, one would have committed the other's
half-finished work. One race also contaminated a test count: an agent reported 384 passing, which
included another task's in-flight tests; the true figure was 366.

**Cost if wrong:** exactly the damage the rule exists to prevent. It cost nothing only by luck.

### A subagent correctly refused an instruction of mine — twice

The plan reviser disagreed with a scan finding and was right: park and a final message are
behaviourally identical *because parking and a final answer are the same terminal event*, and
inventing a difference so a test could discriminate would invent semantics §4 does not have. It
moved the discriminating weight onto `fail` and made the compiler the discriminator for park.

### The recurring defect class, ninth instance

Task 3 produced the ninth "test passes against the wrong implementation" of this project: the
refusal fixture used `content: []`, so a client reading content before `stop_reason` still
returned `'refused'`. The SDK documents refusal as a mid-generation classifier intervention, so
refusal-**with**-content is the expected case. Eight of nine mutants were caught; the one that
passed was the headline one.

---

## Verified end-to-end, not merely tested

Task 11 made the system's first real model call. `LIVE_MODEL=1 pnpm demo` ran one driver turn
against the live API, the model called `explore_flights`, and the conversation spend delta
**exactly** equalled `model_calls.cost_micros` — $0.030420 on both sides. The single-charge
property (B2's whole purpose) is proven against the real API, not a stub. Both live tests report
SKIPPED, not passed, when the gate is unset.

---

## Carried forward, not fixed

- **`netlify/functions/run-turn-background.mts` still runs `echoAgent`.** The real driver has
  never executed in a deployed turn. Wiring it requires `GOOGLE_SEARCH_API` in `env.ts`'s `KEYS`,
  but `loadEnv` is all-or-nothing and fail-fast, so that would force `sweep.mts` to require a
  supplier key with no test harness for either function. Recorded as Tier 4 in
  `docs/backlog-plan.md`. **"The driver replaces the echo agent" is true in code and not yet true
  in production.**
- **`model_calls` cannot reconstruct a driver request** though `capture_policy` says `full`; the
  assembled request is captured nowhere. Backlog §2.3, needs a `request_shape` column. Every call
  until then is a permanent gap in the eval corpus.
- **`rehydrateGate` echoes a raw `sourceId` into a violation `detail`** — the same injection shape
  that `sanitizeSourceId` closed for `propose_itinerary`, one function away. Backlog Tier 3.7.
