# Plan 1 — Lessons from building the agent harness

What we learned building a durable turn-execution harness for an agent loop, and what the
spec assumed that turned out to be wrong.

Scope: agents and agentic systems only. Ordinary engineering hygiene is deliberately omitted.

Plan 1 built the runtime an agent turn executes inside: schema, pure decision engine, claim
with a fencing token, sweeper, spend ledger, four tiers, and a trivial echo agent to prove the
whole thing before a real model was wired in. 12 tasks, 31 commits, 102 tests.

---

## 1. Build the harness before the agent

The single highest-leverage decision in the plan: prove durable execution with an **echo
agent** — a function that returns the last user message — before any model or supplier exists.

Every hard property of an agent loop (crash recovery, concurrent workers, idempotent side
effects, spend ceilings) is a property of the *harness*, not the model. Wiring a model in
first means debugging non-determinism and durability simultaneously, and never knowing which
one broke.

The demo that proves this is six scenarios with no model in sight: a message becomes durable
work, a retried request doesn't buy a second turn, impatient typing doesn't open a second turn
but isn't dropped either, a crash mid-turn resumes without re-running the tool, two workers
race and the loser writes nothing, and every model call is metered before the next is allowed.

**Lesson:** an agent is a model plus a harness. Build and prove the harness on a fake model.

---

## 2. The harness assigns provenance; the model never does

The notebook (the agent's structured memory of user requirements) carries **per-field
provenance**: who set each field, and whether that source is allowed to change it.

Tools cannot relax constraints. A tool result that says "budget: €5000" cannot raise a budget
the user set at €2000. The rule is enforced at the write, not by prompt instruction.

Two rulings during construction sharpened this:
- A non-user source may not **establish** a constraint that was never set, not just fail to
  relax one. "Not yet set" is not permission.
- A patch mixing valid and unrecognised keys is rejected **wholesale**, never partially
  applied. Partial application means the model learns that half-correct writes half-work.

**Lesson:** provenance is a property of the write path. If a model-supplied field would be
trusted anywhere, the schema is wrong — no prompt fixes it.

---

## 3. Persist state, then schedule the next work. Never the reverse.

The sync handler commits the turn row *before* invoking the background worker, and swallows
the invocation's failure. If the invoke fails, the turn is already durably `queued` and the
sweeper rescues it.

Reversed — invoking before the row commits — a crash in between replays work with no durable
record it ever started.

The spec's own source articles got this backwards in one place, which is why the annotation
exists in `docs/part-2-the-harness.md`.

**Lesson:** in an agent loop, durability precedes scheduling, always. The failure mode of the
other order is silent duplicate work.

---

## 4. Every post-claim write carries a fencing token

Turn ownership is a single-statement claim that increments `attempts`. Every subsequent write
is guarded by `and attempts = $claimed`. Zero rows affected means fenced: abort immediately,
write nothing else.

This is what makes a **slow-but-alive** worker safe. The sweeper cannot distinguish "dead" from
"slow", so it will eventually hand a turn to a second worker while the first is still running.
Without fencing, the first worker's late write silently clobbers the second's work.

The demo scenario is worth keeping: worker A claims, worker B takes over the stale turn, worker
A — still alive and unaware — tries to save state and is rejected. `state.step` stays null, not
99.

**Lesson:** an agent worker must assume it has already been superseded. Ownership is proven per
write, not per turn.

---

## 5. Tool-call intent is persisted *before* execution

`tool_calls` rows are written **before** the side effect runs, keyed `(turn_id, call_id)`. This
is what stops a resumed turn from sending a second escalation email or emitting a second set of
tracked links.

The subtle part is the third state. A row that exists as `pending` with no result means the
previous attempt **died mid-side-effect**. We cannot know whether it ran. The harness escalates
rather than guessing either way — retrying risks a duplicate email, skipping risks a lost one.

**Lesson:** an agent's tool calls need three outcomes, not two: fresh, replayed, and
*ambiguous*. Systems that model only success and failure will silently pick one of the two
wrong answers for the ambiguous case.

---

## 6. `recordSpend` is not best-effort; `recordSpan` is

Traces are swallowed on failure. Spend is not — if the ledger write fails, the turn stops.

The spec's v1 inherited a single function for both and would have swallowed the money guardrail
in exactly the failure mode it exists for: a degraded database during a runaway loop.

**Lesson:** observability and enforcement look alike in code and are opposites in intent. Never
let them share an error path.

---

## 7. Fail closed, and check that the check exists

Any limit protecting money **denies** when it cannot confirm current usage. `count ?? 0` is a
banned pattern — it converts "I don't know" into "zero spent", disabling the ceiling at the
exact moment it is needed.

Two ways this bit us:

- The spec said "a lint rule enforces it". **There is no linter in the repo.** The rule is
  enforced by a comment and reviewer attention. A stated enforcement mechanism that doesn't
  exist is worse than an acknowledged convention, because everyone downstream assumes it holds.
- `daily_usage` was read by the $15/day limit and **written by nothing**, so that limit did not
  exist. The spec caught this in review; it is the reason the table is now written on every
  model call.

**Lesson:** for every guardrail, ask two questions — is it enforced, and is the thing it reads
actually written? A limit reading a table nobody populates is decoration.

---

## 8. Platform retry is not a recovery mechanism

The v1 spec claimed the hosting platform's automatic retry would recover crashed turns. It
cannot, for a structural reason: the platform retries only on an **unhandled exception**, and
`runTurn` catches everything. When it does fire (OOM, hard crash) it lands at 1 and 2 minutes,
against a staleness threshold that must exceed the 15-minute execution ceiling — always too
early to reclaim.

The two mechanisms are mutually exclusive by construction. The sweeper is the only recovery
path, and heartbeats are what make it fast.

**Lesson:** if your agent harness catches its own errors — and it must, to record them — your
platform's retry will never fire. Know which of the two you are relying on; you cannot have
both.

---

## 9. Model-version drift cannot be detected by string comparison

The spec prescribed recording `response.model` and comparing it, to detect a silent
weights swap.

**Probed live: `response.model` echoes the alias verbatim.** A request for `claude-opus-5`
returns `"model": "claude-opus-5"`, not a resolved dated version. Every `model_calls` row reads
identically before and after a weights change, so the mitigation detects nothing.

Two consequences, both now in the spec:
- Pin a dated model ID where one exists. For the highest-volume seat there is one; for the
  strongest seats appending a date returns 404.
- For aliased seats the detector must be **behavioural**: replay a fixed prompt set on a
  schedule and alarm on the output distribution, never on the returned string.

Also corrected: the spec's original ID for the strongest model does not exist and 404s.

**Lesson:** verify your drift detector actually detects drift. Probe the provider rather than
reasoning from documentation — this one took a single live call to disprove.

---

## 10. Prompt caching: the transcript *is* the repeated prefix

v1 placed one cache breakpoint on the last system block and sent the growing transcript after
it. In a 20-step agent loop, the transcript — the thing that grows and repeats, which is
exactly what caching exists for — was never cached.

Corrected: a breakpoint on system+tools with a long TTL (a resumed turn is always past the
short default), a **rolling breakpoint on the last content block of the most recent turn**, and
an intermediate one every ~15 blocks to stay inside the lookback window. Memory and the notebook
sit *after* the breakpoint because they change.

And the assertion that verifies it must be **per seat**: a cheap model's minimum cacheable
length means the cheap seats are not expected to cache at all, so a blanket "cache reads > 0"
test gives false confidence.

**Lesson:** cache the thing that grows, not the thing that's static. In an agent loop that is
the transcript, not the system prompt.

---

## 11. What we shipped knowing it was incomplete

Recorded honestly rather than discovered later:

- **Every error maps to `provider_down`.** The echo agent cannot produce a real provider error,
  so the classifier arrives with the model client. Until then the harness cannot distinguish
  retry-able from terminal — a real gap in an agent runtime, and a deliberate one.
- **`step.run()` is still not wrapped in `withHeartbeat`.** The agent call is; the actual
  side-effecting tool execution is not. A tool call exceeding the staleness window gets swept
  out from under a live worker. Fencing makes this correct-but-wasteful rather than corrupt,
  which is why it was survivable — but it is still open, and it becomes load-bearing the moment
  real suppliers make tool calls slow.
- **RLS is enabled but bypassed.** The worker connects as the table owner, which bypasses
  non-forced RLS regardless of policies. There is no row-level tenant isolation today, only
  "no other role can touch these tables". The spec's "the worker connects as an RLS-subject
  role with the request identity set per transaction" is **not implemented**, and the migration
  says so plainly rather than implying otherwise.

**Lesson:** an agent system accumulates deliberate gaps faster than an ordinary one, because so
much of it is scaffolding for a component that doesn't exist yet. Write each one down where the
next person will hit it, not in a document they won't read.

---

## 12. Individual review does not find seam defects

Plan 1's own record: 12 tasks, each reviewed individually, then a whole-branch review found
**3 Critical seam defects no single-task review could see** — including a worker that never
emitted a heartbeat while a step was in flight, and a sweeper that requeued exhausted turns
forever instead of reaping them.

Both are defects *between* correct components. Each task did its job; the joins didn't.

**Lesson:** budget for a whole-branch review as a separate, mandatory pass. It finds a different
class of defect, and the per-task reviews cannot substitute for it however thorough they are.

---

## 13. A model refusal is not an exception

Found while scoping plan 3, and it changes the harness's failure model.

`stop_reason: "refusal"` arrives as an **HTTP 200** with a populated `stop_details` object
carrying a category. It does not throw. An agent runtime whose error handling only inspects
exceptions will read a refusal as a **successful turn that produced no content**, and hand the
user an empty answer with no failure recorded anywhere.

Two consequences for a harness:

- Check `stop_reason` **before** reading `content`, on every response. It is not an error path
  bolted on beside the `catch`; it is part of the normal path.
- The failure taxonomy needs a value for it. `turns.fail_reason` had eight values and none of
  them fits — a refusal is not `provider_down`, not `fetch_failed`, and certainly not success.

**Lesson:** enumerate your agent's terminal states from the API's actual response shapes, not
from the ones that raise. The states that return 200 are the ones you will miss.

---

## 14. Your prior on the request shape is stale too

Section 9 covers drift in what the API *returns*. The request side moves as well, and the
harness had assumptions that are now hard errors:

- **`budget_tokens` is removed** on the current Opus tier — sending it returns **400**. The
  replacement is adaptive thinking plus a separate effort control. The spec's per-seat `effort`
  turned out to be the right shape; a harness that had hardcoded a thinking budget would now be
  failing every call.
- **Assistant prefill returns 400.** Any output-shaping that relied on prefilling the assistant
  turn has to become structured outputs or a system instruction.
- **Thinking is on by default** on the strongest seat, where it previously had to be enabled.

None of these are subtle-wrong. They are 400s — the harness simply stops working. But they only
surface at the first real model call, which in this build is two plans after the code that
assumed them was written.

**Lesson:** when a plan writes model-client code far ahead of executing it, re-verify the request
surface against current documentation at the moment you implement, not the moment you planned.
The failure mode is not a subtle regression; it is a hard error the plan cannot anticipate.
