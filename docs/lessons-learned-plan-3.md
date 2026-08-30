# Plan 3 — Lessons from building the model client and the driver loop

What we learned wiring a real Opus 5 planning desk into the harness, and what the spec and plan
assumed that turned out to be wrong.

Scope: agents and agentic systems only. Ordinary engineering hygiene is deliberately omitted.

Plan 1 built a durable turn harness against a fake model. Plan 2 built the trust boundary that
makes an agent's output safe to act on. Plan 3 finally put a real model behind them: a client, a
seat table, prompt caching, a reserve/reconcile money path, tool assembly, and the driver loop
that ties them together. 12 tasks, 26 commits, 520 tests.

**The distinguishing fact about this plan: I wrote it, and the pre-flight scan of my own plan
found 29 conflicts, six blocking — three of them money or correctness bugs that would have
shipped.** Most of Part II follows from that.

Two axes below: **designing the system**, and **using agents to build it**.

---

# Part I — Designing the agentic system

## 1. A refusal is an HTTP 200, and the type system is the only thing that will remind you

`stop_reason: 'refusal'` is a successful response. No exception is thrown, no status code is
unusual, and the `content` array is often non-empty because refusal is a mid-generation
classifier intervention rather than a pre-generation block.

Every instinct says errors arrive as thrown errors. Here the most consequential failure arrives
as a 200 with a field set. So `callModel` returns a **discriminated union** rather than a message:

```
ModelResult = { kind: 'ok', ... } | { kind: 'refused', ... } | ...
```

Forgetting the refusal case is now a compile error, not a silent read of empty content as a
successful empty answer. This is the whole reason the union exists — a boolean `refused` flag
alongside the content would have been ignorable.

## 2. The SDK's types do not track the API's request surface

`budget_tokens` returns **400** on Opus 5. It is also **still present in the installed SDK
types**. `tsc` therefore cannot catch it. Same for assistant prefill.

This is the uncomfortable one: the type system that caught the refusal bug is blind to the drift
that breaks every call. A hand-written *shape test* — asserting what the assembled request does
and does not contain — is the only guard, and it looks redundant to anyone reading it later. It
is not. The pre-flight ruling explicitly recorded "deleting that test as redundant restores a
silent 400 on every call."

**Generalisation:** in a fast-moving API, verify the *request* surface with tests, not just the
response handling. The compiler validates the shape your SDK version believes in, which is not
necessarily the shape the server accepts.

## 3. Estimation must derive from the same function that builds the request

Task 3's Critical: `estimateInputTokens` assembled its own approximation of the request, so a
suffix the real `buildRequest` added was counted as zero. The estimate and the request drifted
because they were two constructions of the same thing.

The fix was structural, not arithmetic: `estimateInputTokens` now calls `buildRequest` and
measures **the thing that will actually be sent**. The suffix is included *by construction* — it
added 756 tokens for a 2,240-character notebook that previously contributed nothing.

Reviewers later confirmed the property held by checking there was **no second
request-construction path** anywhere. That is the invariant worth pinning: one assembly path.

## 4. A reservation that can undercount is not a guardrail

Spend control is reserve-before-call, reconcile-after. The reservation deliberately over-estimates
so `reconcile` normally refunds.

The final review found `estimateMicros` was *documented* as an upper bound and was not one: a 1h
cache write bills at 2× base input, and the driver sets a 1h TTL on every call, so a cold cache
could bill above the reservation. The implementer chose to **fix the code rather than correct the
docstring**, on the reasoning that *"a guardrail allowed to undercount isn't a guardrail."* That
was the right call, and it is the same principle as pre-flight ruling B6: **undercounting a money
guardrail is the one direction pricing must never err.**

The reciprocal test matters as much as the fix: a usage fixture that is *entirely* cache-creation
tokens must price at or below the reservation for the same token count. Without it, the multiplier
is a comment.

## 5. Count the doors that move money, and keep one definition of the ceiling

The whole-branch review was asked one question above all others: **how many functions move
`conversations.spend_usd_micros` or `daily_usage.cost_micros`?**

**CORRECTED** (this document originally quoted the review's answer as *"exactly four… I found
no fourth door"*, which is self-contradictory as transcribed and was never re-verified before
being written down here). The real count, verified by grepping `src/` and `netlify/` for
`update conversations`, `insert into daily_usage`, and `update daily_usage`: **three** functions
move one of those two columns —

- `recordSpend` (`src/repo/spend.ts:47`)
- `reserve` (`src/repo/reservation.ts:74`)
- `reconcile` (`src/repo/reservation.ts:137`)

`completeTurn` and `failTurn` (`src/repo/turns.ts`) also write a column named
`spend_usd_micros`, but it is `turns.spend_usd_micros` — a different column on a different
table, tracking what one turn spent rather than the account-level ceiling — which is why
counting it would make five, not four: it is a different kind of door, not a fourth instance of
this one. Neither of those two functions is a door on the question actually asked. The general
lesson stands regardless of the exact number: it is a statement about the shape of the system,
worth more than any number of passing tests, and worth re-deriving rather than re-quoting.

Separately, three tiers had each hand-written the same "is any ceiling reached" comparison:
`decideNext`, `submitMessage`, and the driver. The driver's copy also needed to know *which*
ceiling fired, to pick the right message. Three copies of a money predicate is exactly what a
shared constants file argues against, one level up — and a typo'd field pair
(`dailyMicros >= globalCeilingMicros`) **type-checks fine**.

`firstCeilingReached` is now the single definition; `exceedsAnyCeiling` wraps it for the two
consumers that only need the boolean.

## 6. Three double-charges, through three unrelated doors

This is the headline finding of the plan. The same bug class appeared three times, in three places
that share no code:

1. **The driver reserved and reconciled its own spend, while the worker also called `recordSpend`
   on top.** Caught by the pre-flight scan. Nothing else caught it because no test ran the driver
   through `runTurn` — the seam between the two halves was the one place no test looked.
2. **An agent named the same micros in both `costMicros` and `recordedMicros`.** Legal shapes,
   wrong meaning: setting both is *fine* (each is charged through its own door once); naming the
   *same* micros twice is the violation.
3. **A brief-supplied branch re-added a pre-computed total** — my own park-case snippet added
   `alreadyDebited` when the worker already adds it above the switch.

**The lesson: money invariants in an agentic system are not reviewable by reading.** Three
competent readers passed over these. What caught them was execution — a scan that traced call
paths, a reviewer that reproduced the arithmetic empirically (240000n vs 120000n expected), and an
implementer who ran my snippet against my own test.

## 7. "Make it unrepresentable" has a boundary, and this plan found it

The instinct after defect 2 above was to make the bad state unrepresentable — a discriminated pair
so a step cannot carry both `costMicros` and `recordedMicros`.

The reviewer **overturned it with better reasoning than my question**: that shape would *forbid* a
legitimate case Task 10 needs — a tool step whose model call was self-debited **and** whose
supplier cost is worker-debited. Both fields set, correctly, both charged once.

First time in this project that "make it unrepresentable" was the wrong move. Worth knowing the
boundary exists: the technique fails when the "invalid" combination is actually a valid composite,
and the real invariant is about *meaning* (the same micros named twice) rather than *shape*.

## 8. The transcript is a typed structure. Flattening it to strings destroys two things

There is **no `'tool'` role.** An Anthropic transcript carries a tool result as a `tool_result`
block inside a **user** message, referencing the `tool_use` block's id in the preceding assistant
message. Flattening to a string kills:

- **the `tool_use` id and its structured input** — without the id, a result cannot be paired with
  its call, and an unpaired `tool_result` is a **400 on the next request**, not a degraded answer;
- **a thinking block's `signature`** — extended thinking must be echoed back byte-for-byte across a
  multi-step loop, and a stringified thinking block is rejected.

`turns.state` was already `jsonb`, so widening the type needed no migration — but every block must
now survive a JSON round trip unchanged, which is pinned by test.

## 9. The bug that would have 400'd every single tool call

`loop()` never appended the assistant turn carrying the `tool_use` before appending the
`tool_result`. The driver's second step would therefore have sent a malformed transcript and
failed on **every tool call the system ever made.**

Both the pre-flight scan and I missed it. The plan reviser found it. It is worth recording plainly:
the most total failure in the plan was invisible to a structured 29-row conflict scan, because it
was an *omission* in a sequence, not a contradiction between two stated things. Scans find
disagreements; they do not find silence.

## 10. Prompt caching is a prefix match, with three non-obvious constraints

- **Cache the transcript, not just the system prompt.** The system+tools prefix is stable and gets
  a 1h TTL; the real savings come from a rolling breakpoint on the growing transcript.
- **Thinking blocks cannot carry `cache_control`.** The breakpoint walk must *skip to the next
  eligible block* rather than special-casing.
- **Find the rolling breakpoint by searching backward**, not by assuming `content.at(-1)` — a
  trailing empty content array otherwise indexes at -1.

Both of the latter two were real API constraints an implementer found and handled without being
told. Also: the **minimum cacheable prefix is model-dependent** (Opus 5 = 512 tokens, Haiku 4.5 =
4096). A per-seat expectation of cache reads is how you notice caching silently stopped working —
a cache that never hits costs money and raises no error.

## 11. A default parameter is how a 1h write silently bills at the 5m rate

`costMicros` takes the cache TTL as a **required** third parameter. Making it optional with a `'5m'`
default would mean every call site that forgot it under-bills by 60%, with no error and no failing
test — an under-count being indistinguishable from a legitimately small number.

Same reasoning appears in the schema lockdown doc about the global daily ceiling: **an under-count
is the dangerous direction precisely because nothing surfaces it.**

## 12. Provenance must be *derived* from the transcript, not prescribed

My brief prescribed `source: 'user'` for `update_requirements`. That left `applyRequirements` with
no reachable caller for its other branch — **the whole provenance system was inert.** Two lines in
`notebook.ts` claiming a defence never fired.

The exploit needs no adversary: the model reads a supplier price above her budget and raises the
budget to fit its own plan.

My brief posed a false binary, and the implementer was right that `'inferred'` unconditionally
would **wedge her permanently** — she could never state a requirement. The correct answer was
neither: **derive it from whether this turn's transcript already holds a `tool_result`.** Step 0 is
provably her words alone, because `loop()` hydrates role and text only — independently verified by
tracing both writers of `state.messages` and confirming no path carries a `tool_result` across a
turn boundary.

## 13. Taint is not door-scoped, because an unfenced door can still carry supplier money

I proposed narrowing the provenance taint to untrusted doors. **The reviewer overturned it and was
right.**

`propose_itinerary` is a `code` door and therefore *not* fenced — yet its rejection text embeds
supplier-derived money: *"this trip totals EUR X, over your EUR Y budget."* That is the exact
sentence that motivates a traveller raising her budget. A door-based rule would stamp the following
write `'user'` and **open a hole at the money gate.**

The general shape: *trusted door* and *carries untrusted data* are independent properties. Fencing
is about delimiter injection; taint is about provenance. Conflating them puts a hole exactly where
the two differ.

## 14. The harness assigns provenance — and that needs a test aimed at the schema

"The harness assigns provenance, the model never does" is a Critical-severity constraint, and every
tool schema honoured it. But **no test pinned it.** Widening `UpdateRequirements` to accept a
`source` field would have passed the entire suite.

The fix is a regression test asserting the schemas **reject** a model-supplied `source`/`stated_by`.
Constraints that are currently true by everyone's good judgment need a test, or the next widening
is silent.

## 15. Fencing a tool result means escaping the tool name too

`fenceResult` HTML-entity-escapes the payload **and the tool name**, because the name is
interpolated into the delimiter's attributes. The reviewer attacked it on paper with exact,
case-varied, and whitespace-varied closing tags, nested attempts, and attribute injection through
the name; all held.

**Two residuals accepted deliberately:** unicode homoglyphs and already-escaped payloads pass
through. Neither is a breakout, because the model is the sole consumer and nothing downstream
matches the literal delimiter. Recording *why* a residual is acceptable is what makes it a decision
rather than an oversight.

A related surface was **partially** closed: supplier-controlled `sourceId` strings are sanitised at
`propose_itinerary`'s two interpolation points but still reach the model raw through
`rehydrateGate`'s violation detail. Recorded as backlog Tier 3.7 rather than fixed after the wave
closed. Injection surfaces come in families; closing one instance is not closing the shape.

## 16. A per-turn tool budget must count calls that died mid-flight

`countSupplierCalls` counts `tool_calls` rows for the turn — and must count **`pending`** rows, not
just completed ones. A row stuck in `pending` is precisely a call that fired and whose process
died; excluding it lets a crash-looping turn re-spend the supplier budget from zero each time.

No test seeded a `pending` row, so a regression adding `and status = 'done'` would have passed
everything — while breaking the exact case that matters most.

Related: `countSupplierCalls` **throws rather than returning 0** when it cannot read. A budget
reader that fails open is not a budget.

## 17. Spans are best-effort; spend is not

`recordModelCall` is best-effort — its failure is swallowed and logged, because losing an
observability row must never fail a turn the user paid for. `recordSpend`, `reserve`, and
`reconcile` are the opposite: their failure must propagate.

The asymmetry is deliberate and easy to erode, since both look like "write a row after the call."
The rule: **a row that describes what happened may be lost; a row that determines what may happen
next may not.**

## 18. Redact credentials before serialisation, and remember the nested case

`redactCredentials` runs five patterns *before* the payload is serialised, and the result is
re-parsed. The nested case — a credential planted inside `ModelResult.content` rather than at the
top level — is the very reason the redact-then-reparse design exists, and it initially rested on
code inspection with no test. It got one.

Anything that captures model I/O for observability is a credential exfiltration path by default.
This project also learned it the hard way outside the code: a malformed `DATABASE_URL` didn't match
a masking regex and echoed a live password into a transcript.

## 19. Seats are the drift anchor

`modelConfigId` encodes model + effort + max tokens. Seat names match the `model_calls.seat` check
constraint exactly — verified name by name against the migration.

This matters because **`response.model` echoes the alias you sent.** Asking a `claude-opus-5`
request what model answered returns `claude-opus-5`, so string comparison detects nothing when the
alias moves under you. Haiku 4.5 is currently the *only* model with a dated snapshot; every other
current model is alias-only. So drift detection on the aliased seats has to be **behavioural**, and
the config id is what a behavioural canary is pinned against.

---

# Part II — Using agents to build the agentic system

## 20. Scan your own plan hardest

The pre-flight scan of a plan **I wrote** found 29 conflicts, six blocking, three of them money or
correctness bugs. The verdict was that the plan needed **revision, not per-task correction** — the
architecture was wrong in places, not just the details.

Plan 2's scan found 30 conflicts in a plan I had also just written. The rate is not improving with
practice, which is the actual lesson: **a plan is a design artifact and deserves a design review,
and authorship provides no immunity.** The scan is still the cheapest review in the process — it
runs before any code exists, so its findings cost nothing to act on.

But see §9: scans find contradictions between stated things. They do not find omissions.

## 21. A plan written against an existing harness will duplicate the harness

Blocking findings B2 and B3 are the same mistake in two places: my plan re-implemented machinery
plan 1 already owned. B2 duplicated the **spend writer**; B3 duplicated the **`tool_calls`
writer**.

Both were invisible to tests for the same reason — no test exercised the *seam* between the new
component and the existing one. The fix in both cases was to delete my version and route through
the harness: the pure half of tool handling moved to the driver, the durable half stayed in the
worker as the single writer.

**When planning a new component against an existing system, enumerate what already writes to each
table before designing anything that writes to it.**

## 22. Three of the plan's defects were in my briefs, and implementers caught them by executing

- `source: 'user'` (§12) — prescribed by my brief, made the provenance system inert.
- The refund cut line — my proposed fix **would not have fixed the outage**: 429s and 5xx classify
  as `provider_down`, the very bucket the split keeps. The right question is "did a response body
  reach us?" — an error body carries no usage, so nothing was billed. I had also mis-scoped the
  exposure as ~20 per conversation; it is ~123 **across all users**, because stranded micros land
  in `daily_usage` and the global ceiling sums cross-user. A ten-minute provider blip becomes a
  day-long self-inflicted outage at zero real spend.
- The park-case double-charge (§6.3) — the implementer caught it by **running my snippet against my
  own test.**

The pattern in all three: the defect was in prose that read fine and failed when executed. The
countermeasure is not better prose review; it is that implementers are instructed to run the brief's
own snippets against the brief's own tests, and to report a contradiction rather than resolve it
silently.

## 23. Subagents correctly refused or overturned me at least five times

Worth listing, because the reflex is to treat a disagreeing subagent as a subagent that
misunderstood:

1. The plan reviser **disagreed with a scan finding and was right** — park and a final message are
   behaviourally identical *because parking and a final answer are the same terminal event*.
   Inventing a difference so a test could discriminate would have invented semantics §4 lacks. It
   moved the weight onto `fail` and made the compiler the discriminator for park.
2. It **deleted** a test I asked to be repaired: `test/sweeper.test.ts` already pinned the property,
   and a weaker second copy is coverage theatre.
3. A reviewer **overturned "make it unrepresentable"** (§7) with better reasoning than my question.
4. A reviewer **overturned door-scoped taint** (§13), catching a hole at the money gate.
5. An implementer **refused a false binary** in my brief (§12) and derived the third option.

Also: an implementer **correctly refused to touch another task's work-in-progress** during a git
race and flagged it instead. That was its discipline, not my design.

**A subagent that pushes back is doing the job.** Every one of these was cheaper than the defect it
prevented.

## 24. One implementer at a time — a rule I wrote and then broke twice

I dispatched Task 3's implementer in parallel with Task 2b's **fix round**, having failed to
register that *a fix round is an implementer*. Then I did it again, dispatching Task 4's fix round
while Task 6's implementer was running.

Both times the files happened to be disjoint. **That is luck twice, not design.** One race did
occur: Task 4's fix round hit a concurrent `git add` and briefly held another agent's files in its
index. It soft-reset, selectively unstaged, and verified the other agent's files were untouched
rather than forcing. No data lost — because the agent handled it well, not because the process was
sound.

A parallel run also **contaminated a test count**: an agent reported 384 passing, which included
another task's in-flight tests. The true figure was 366. Numbers reported from a shared working
tree are not trustworthy while two writers exist.

The final rule: **reviews may run in parallel with an implementer; a second implementer, including
any fix round, may not.** Writing the rule down did not enforce it — the second violation happened
*after* I recorded the first. What enforced it was refusing to dispatch until named commits had
reported.

## 25. Batch same-shape fixes into one dispatch

Three findings across two tasks were all the same shape: *"add a regression test pinning a
constraint the code already honours."* They went as **one** dispatch rather than three, and were
reviewed as one diff.

All three were proven to discriminate by **breaking the guarded constraint and reverting** —
widening `UpdateRequirements`, adding `and status = 'done'`, dropping `explore_hotels` from
`SUPPLIER_DOORS`. No production code changed.

## 26. The way to know a test discriminates is to break the thing it guards

Used throughout this plan, and it repeatedly found tests that proved nothing:

- A tautological upper-bound test was **replaced, not supplemented** (verified by grep, zero hits).
- Every cache fixture's pre-round value was already an integer, so `ceil`/`round`/`floor` were
  indistinguishable and "must round up" was enforced **by a comment alone**. Now pinned with a
  fractional fixture and proven to fail under `Math.floor`.
- A reviewer identified **which** of two tests discriminates the double-charge: only the one where
  `recordedMicros` is set. The other has `alreadyDebited = 0n` — a suite with only that test ships
  the bug.

That last one is the sharpest form of the idea: it is not enough that a passing test exists for a
behaviour; you have to know *which* test would fail.

## 27. The recurring defect class, ninth instance

Task 3's refusal fixture used `content: []`, so a client reading content *before* `stop_reason`
still returned `'refused'`. The test passed against the wrong implementation. Eight of nine mutants
were caught; **the one that passed was the headline one.**

This is the ninth instance across the project, and plan 2's own constraints named it as plan 1's
recurring finding *before plan 2 started*. Writing the rule down has never prevented it. Adversarial
verification — mutation, reciprocal fixtures, breaking-the-constraint — has caught it every time.

## 28. "Record, don't half-wire" is a legitimate outcome

The fix wave was asked to wire the driver into the Netlify entry point. It **recorded instead**, and
the reasoning held up under scrutiny: `SearchApiHotels` throws at construction without
`GOOGLE_SEARCH_API`; `env.ts`'s `loadEnv` is all-or-nothing and fail-fast; so adding the key would
force `sweep.mts` to require a supplier key, with no test harness for either function.

The re-reviewer verified every underlying claim independently rather than accepting the narrative,
and noted the demo sidesteps the same issue with `MockSupplier` — confirming this is a real problem
being surfaced, not a solved one being hidden.

The residual is stated plainly: **the driver has never executed in a deployed turn.** "The driver
replaces the echo agent" is true in code and not yet true in production. An agent that reports the
gap accurately is more useful than one that closes it by weakening a fail-fast convention.

## 29. A correction can become the next wrong comment

Plan 2 identified **eleven** wrong comments on contracts, with the mechanism named as *post-hoc
rationalisation of a correct call.* Plan 3 added a twelfth (an implementer's report claiming a
mixed-micros step would not double-charge the conversation ledger — false, struck in place), then
corrected five more in the fix wave.

Because a comment corrected into a *different* wrong claim is worse than the original, the
re-review was explicitly asked to verify the five corrected comments against source rather than
accept them. All five checked out. **When a fix wave touches five comments at once, verify the
corrections, not just the code.**

## 30. Verify against the real API once, end to end, before believing any of it

Task 11 made the system's first real model call. `LIVE_MODEL=1 pnpm demo` ran one driver turn
against the live API; the model called `explore_flights`; and the conversation spend delta
**exactly** equalled `model_calls.cost_micros` — $0.030420 on both sides.

That single run proved the property that six of this plan's rulings exist to protect, against the
real API rather than a stub. Everything before it was an argument.

The live tests report **SKIPPED, not passed**, when the gate is unset — so a suite run without
credentials cannot be mistaken for a suite that verified the live path.
