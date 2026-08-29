# Plan 2 — Lessons from building the trust boundary

What we learned building the supplier port and the deterministic gates, and what the spec and
plan assumed that turned out to be wrong.

Scope: agents and agentic systems only. Ordinary engineering hygiene is deliberately omitted.

Plan 2 built the layer that makes an agent's output trustworthy: a supplier port over one mock
and two live sources, a provenance corpus, and seven deterministic gates. 12 tasks (plus one
added mid-flight), 25 commits, 294 tests.

Two axes below: **designing the system**, and **using agents to build it**.

---

# Part I — Designing the agentic system

## 1. The model proposes references, never values

The central move of the whole plan. `propose_itinerary` accepts `{sourceId, quantity, slot}`
and **nothing else**. A gate then rehydrates every field server-side from the provenance corpus
and discards whatever the model wrote.

A `sourceId` the corpus has never seen *is* the provenance failure — it means the model
invented it. There is no field to hallucinate a price into, because there is no price field.

This is stronger than validating model output, because there is nothing to validate. The
guarantee doesn't depend on a check being thorough; it depends on the shape of the interface.

**Lesson:** don't ask the model for data you can look up. Ask for a reference and do the lookup.

## 2. Make the boundary check unskippable, not merely present

The first version of the rehydration gate accepted `ItemRef[]` and trusted the caller to have
parsed. TypeScript is erased at runtime, so raw model JSON cast through `as ItemRef[]` would
carry an extra `price` field straight onto the output object.

The fix re-applies the schema **inside** the function. The boundary check cannot be skipped by
construction, rather than by the caller remembering.

The same principle recurred four more times, and each time the structural version won:
- the output `ref` is **rebuilt** field-by-field, never aliased from the caller's object;
- `ok: true` is a positive condition on `total !== null`, so the success arm cannot syntactically
  carry a fabricated total;
- `GateName` is **derived** from the runtime `GATE_NAMES` array, so a gate that doesn't get an
  audit row is unrepresentable rather than merely detected by a test;
- the audit row type is a discriminated union, so "not evaluated without a reason" is a compile
  error.

**Lesson:** every convention in an agent's trust boundary eventually gets skipped. Prefer the
version the compiler or the control flow enforces, even when it's uglier.

## 3. The one hole: a model-supplied value that survived rehydration

`quantity` is model-written, kept, and multiplied into the trip total:
`total = Σ(corpus_price × model_quantity)`.

Twelve task reviews checked it against its **schema** — positive integer, bounded to 16, no
overflow — and every one was right. The whole-branch review checked it against **what the number
means in the captured data**:

- Kiwi's fixture: `query: "BER → FAO … 2 adults"`, `price: 464`. That's the **party total**.
- SearchApi: the adapter reads `total_price` over the requested window. That's the **whole stay**.

So the only correct `quantity` is `1`, and a model sending `16` got a 16× total back with the
audit recording `totals: pass`. The error direction was inflation — safe for a budget check —
and no renderer existed yet, which is why it was survivable. But it was the single exception to
the headline guarantee, and nothing anywhere named it.

**Lesson:** validating a model-supplied number against its type tells you nothing about whether
its *meaning* is right. For any value the model controls that reaches arithmetic, ask what it
means in the actual supplier data — and read the captured response to find out.

## 4. A gate returns violations; it does not throw. An adapter may throw.

The division that made everything else work. An **adapter** talking to a supplier throws — a
mismatched currency, an unusable price, a malformed response are all failures of the call. A
**gate** evaluating model output returns violations, because its output is a message the agent
must read and act on.

A gate that throws turns an actionable rejection into a crashed turn, and the audit table that
exists to record why the proposal was refused records nothing at all.

Every throwing call site (`sumMoney` on empty, `compareMoney` across currencies, `itemTotal` on
a fractional quantity) has a guard traced to it. One of those throws was mandated by the plan's
own code — `BigInt(1.5)` raises `RangeError` inside a gate whose entire job is to report faults
— and was caught before shipping.

**Lesson:** decide explicitly which layers of your agent may throw. The boundary is where the
output stops being a system error and starts being feedback for the model.

## 5. Report every violation at once, and one fault only once

Two rules that pull in opposite directions and both matter:

**All at once.** Missing source ids are reported together, not one per round trip. One-at-a-time
rejection costs a model call per bad reference *and* the model never sees the pattern in its own
error — it fixes one id, resubmits, and gets rejected again.

**Only once.** As the plan was written, a single mixed-currency proposal produced **three**
violations — `currency`, `totals`, `budget` — because `checkTotals` re-implemented the currency
detection and `checkBudget` re-ran `checkTotals`. Three descriptions of one fault teach the model
that its proposal was wrong in three ways.

The fix was to widen one function's signature (`expected: string | null`) so the others could
call it rather than duplicate it.

**Lesson:** an agent's error messages are an interface, not a log. Completeness and
non-duplication are both correctness properties of that interface.

## 6. An audit needs three verdicts, not two

`gate_results` records passes as well as failures, because the question the next slice asks
first is *"how often did this gate fire?"* — unanswerable from failures alone.

That forced a third state. When a currency fault means the total could never be computed, the
budget gate did not **fail** — it never **ran**. Recording that as `pass` inflates the pass rate
and makes a gate look useless when it simply never fired.

The refinements took three rounds to get right, and the discriminator matters:
- `false` if this gate filed a violation — it ran and rejected;
- `null` if it could not evaluate — with the *reason* in a separate column, because "no budget
  configured" and "no total to compare" are different nulls;
- `true` otherwise.

And one deliberate **absence**: a gate skipped because provenance short-circuited writes **no
row**. Absence is already distinguishable from "ran and passed", and it is the honest denominator
for a fire-rate query. Writing six extra rows every time a model hallucinates an id would make
the failure case dominate the table.

**Lesson:** if you are going to evaluate whether an agent's components earn their keep, the
instrumentation has to distinguish *didn't fire* from *fired and passed*. Two-state logging
cannot.

## 7. Unknown is not unchanged

The posture that made the system coherent, stated once and then applied everywhere:

- an unparseable `fetchedAt` is **stale**, not fresh — NaN comparisons are all false, so an
  ordinary bounds check would have silently classified corrupt data as fresh;
- a tool call that died mid-side-effect **escalates**, it doesn't retry or skip;
- a re-quote that throws **blocks** the hand-off rather than assuming the price held;
- and — caught in the final review — a **missing** currency echo must throw, not be treated as
  agreement. Both adapters had `if (echoed && echoed !== requested) throw`, so an absent field
  meant the requested currency was stamped onto whatever came back. *Absence of evidence is not
  confirmation*, and the branch already knew that everywhere else.

**Lesson:** pick this rule once, write it down, then audit every branch that treats a missing
value as a passing one. They will not all be obvious.

## 8. Two adapters must agree about the same hazard

Kiwi verified the response's echoed currency and threw. SearchApi stamped the requested code on
whatever came back. Two adapters behind one port, taking **opposite positions on the same
question**, in a system whose stated rule is "refuse, never convert".

Worse: the plan's fixture-cleaning script deleted the whole `search_parameters` block — the one
field that echoes the honoured currency — so no test could ever have caught it.

**Lesson:** a port is a contract about behaviour, not just types. When adapters are built as
separate tasks, diff their *decisions* against each other, not only their signatures. And never
let a fixture-sanitising step remove the evidence a check depends on.

## 9. Publish the vocabulary the model is expected to use

`checkSlots` rejected anything outside a known slot vocabulary. The schema accepted any 64-character
string. The vocabulary appeared in no tool description anywhere. And the plan's own test
fixtures used `slot: 'a'`, `'b'`, `'x'`, `'y'` — every one of which becomes a violation the moment
the gate is wired in.

**Lesson:** if a gate enforces an enumeration, the model must be able to see the enumeration —
in the schema, in the tool description, and derived from one definition so they cannot drift.

## 10. Provenance defends against hallucination, not against an adversary

Kept in the code verbatim, because it is the sentence most likely to be forgotten:

> Provenance defends against hallucination, not against an adversary who is legitimately in the
> supplier's index.

Rehydrating from the corpus proves the model didn't invent the price. It proves nothing about
whether the listing itself is hostile. That's a different defence, and conflating the two is how
a provenance system gets oversold.

Related, and load-bearing: the notebook refuses a `tool` source for **any** write to `budget` —
not just a relaxation — so an injected listing cannot establish the budget that the budget gate
then reads.

**Lesson:** state what your defence does *not* cover, in the code, next to the defence.

## 11. Some hazards cannot be tested from inside the privilege that creates them

The global spend ceiling sums across all users. Under a future forced-RLS migration with
per-user policies, that sum would silently return only the caller's rows — the ceiling would read
far below the cap and stop firing, with no error and no failing test, because an under-count is
indistinguishable from a legitimately small total.

The test that pins the sum connects as the table owner. **It can never catch this.**

The only available defence was a written warning, placed on the table itself and in the migration
that plans the policies — where the person who will cause the problem is actually looking.

**Lesson:** when a hazard is invisible from your test's privilege level, a comment at the point
of change is not laziness — it's the only mechanism available. Put it where the future author
will be, not in a design doc.

## 12. A money bug found by a guard added for something else

Task 10 pinned a non-UTC timezone for the test run, because under `TZ=UTC` a date test meant to
prove "never parse a naive ISO string as a `Date`" passes against the wrong implementation.

Two tasks later that pin caught something unrelated: `current_date` in Postgres is
session-timezone dependent, so the spend **writer** and the spend **reader** could bucket into
different days and the money ceilings would silently stop counting. The test caught the merged
code red-handed — `expected '2026-08-30' to be '2026-08-29'`.

It was **latent**, not live: the session zone happened to be UTC. The implementer reported it that
way rather than overselling it, which is the right call.

**Lesson:** guards that make tests discriminate pay off in places you did not aim them. And in a
system where an agent's spend limits are the only thing between you and an unbounded bill, the
day boundary is a correctness property, not a formatting detail.

## 12b. A provenance corpus that overwrites cannot answer "what did the gate see?"

`tool_results` is the corpus the gates rehydrate from. The spec says **append-only**. The
implementation upserts: a re-search overwrites the previous quote's price and timestamp.

The justification is real — when the freshness gate says "these prices are too old, search
again", the re-search must be able to move `fetched_at`, or the gate rejects the retry for
exactly the reason the retry existed. But the consequence is that a proposal which was *rejected*
by a gate leaves no record of the price it was rejected on. Anything that became a proposal is
safe, because the rehydrated itinerary is snapshotted there. Everything the gates refused is not.

That is the corpus's whole purpose in the next slice: replaying a conversation and asking why a
gate fired. This is also the one deferred item whose cost **accrues while it waits** — every
re-quote destroys one more historical price, unrecoverably.

**Lesson:** for an agent's provenance store, "append-only" is not a retention preference, it is
what makes the store answer questions about the past. If you must upsert, know that you have
traded away replay, and write down what it costs.

## 12c. Metered tool calls need a per-turn budget, and the loop is where it goes

Spec §8 names a per-turn supplier-call budget, and calls its absence a defect being fixed. It
shipped unimplemented — defensibly, because the supplier `search()` and `quote()` methods had no
callers outside tests. There was genuinely nothing to count.

But that is the shape of the trap: the budget is easy to defer while building the *port*, and by
the time there are call sites they are inside an agent loop that can run a couple of dozen steps.
Model spend was capped from plan 1. Supplier calls — rate-limited and sometimes metered — were
not capped at all.

**Lesson:** an agent loop needs a ceiling on every metered resource it can consume, not just
tokens. Add the counter when you build the loop, not when you notice the bill.

## 12d. An audit table needs a uniqueness rule, or the fire-rate is fiction

`gate_results.round` defaults to `0` and there is no unique constraint on
`(conversation_id, proposal_id, round, gate)`. Two gate runs in one turn that both leave `round`
at its default write two complete sets of rows.

The question this table exists to answer is "how often did this gate fire?". Double-counted rows
do not corrupt anything a user sees — they corrupt the measurement you plan to make decisions
with, which is worse in a quieter way, because nothing looks broken.

**Lesson:** if instrumentation is going to justify keeping or cutting a component, its
uniqueness rule is part of its correctness. An audit row you can accidentally write twice is not
evidence.


---

# Part II — Using agents to build the agentic system

## 13. The recurring defect: tests that pass against the wrong implementation

**Eight-plus instances across two plans.** Not a coincidence — the single most common defect in
the entire run:

- a cascade test named "tool_results *and proposals*" that never inserted a proposal;
- two rejected inserts in one transaction, so the first aborted it and the second assertion never
  ran;
- an idempotency test that spread `fetchedAt` through unchanged and then asserted `>=`;
- a float test asserting `price.minor % 100n === 0n`, which `Math.trunc` passes;
- a second float test pinning `452.35 → 45235n`, where `452.35 * 100` is *exactly* `45235` so
  round and trunc agree;
- an isolation test where both conversations were seeded with identical params, so the id was
  found in the second conversation's own rows;
- a currency test that a deliberately broken implementation ignoring the expected currency passed
  **all four** of;
- a date test that a naive-`Date` implementation passes under `TZ=UTC`.

**The sharpest part:** Plan 2's own global constraints *named this* as Plan 1's recurring
finding, in writing, before Plan 2 started — "Plan 1's recurring finding was tests that passed
regardless." And Plan 2 shipped seven more.

**Lesson:** writing the rule in the plan did not prevent the defect. What caught it was
adversarially verifying each test — writing the wrong implementation and checking the test
actually fails. Every instance above was found by someone doing that, not by someone reading
the test.

## 14. Demand evidence, not assertions

The fix that made reviews reliable: don't accept "I added a test that discriminates". Require
*break it, watch it fail, restore it, watch it pass* — and paste both outputs.

This caught a real gap. An implementer reported proving discrimination; the re-reviewer noticed
the proof used a **weaker break** than the finding named, re-ran the literal attack itself, and
confirmed three tests failed. The fix was sound either way, but the evidence hadn't shown what
it claimed.

**Lesson:** in a review loop between agents, an assertion of correctness is worth roughly nothing.
A pasted failing output is worth a great deal.

## 15. Reviewers that verify beat reviewers that read

The reviews that found real defects did work beyond reading the diff:

- recomputed `8.29 * 100` and `452.35 * 100` in Node to check which values actually diverge under
  truncation;
- read the **captured fixtures** to learn what a price covers — which is how the `quantity` hole
  was found;
- reproduced a collection-time throw by unsetting an env var;
- quoted the spec text directly to disprove a claim that the spec was self-contradictory;
- read the *next* task's brief to check whether a reuse requirement would actually land — it
  wouldn't;
- re-ran a prior reviewer's attack rather than trusting that it had been addressed.

**Lesson:** ask reviewers for the specific check, not for an opinion. "Verify this numerically",
"read the fixture and tell me what the price covers", "write the broken implementation and walk
it against every test."

## 16. A pre-flight scan is the cheapest review you will run

Before a line was written, one agent read all 12 tasks against the spec and against the merged
code from Plan 1, and produced a table: every pair of tasks sharing a file or interface, every
task checked against itself, every plan-vs-spec conflict.

**65 rows, 30 genuine conflicts, 6 blocking.** Including a task that contradicts its own test, a
type change that breaks `tsc` in files the plan doesn't mention, and a spec-mandated gate that
nothing in the plan implements.

Two of those blocking findings would have shipped a broken audit table; one would have failed at
the first compile.

**Lesson:** the plan is not the spec, and a long plan written ahead of the code will disagree
with itself. Reading it adversarially *once*, before execution, is far cheaper than discovering
each conflict at the task that trips over it.

## 17. The implementers found defects in their own briefs

Repeatedly, and unprompted:
- a `safeParse(args.refs)` against a `strictObject({refs})` that would have rejected 100% of
  proposals;
- a row type whose `boolean` field could not express the third state the task required;
- a test helper seeding every conversation with identical parameters, so a deterministic mock
  produced identical ids and the isolation test proved nothing;
- a `BigInt(quantity)` that throws `RangeError` on a fractional value, inside a gate.

**Lesson:** an implementer with enough context to disagree with its brief is more valuable than
one that follows it exactly. Say explicitly that the brief may be wrong and that reporting it is
the expected behaviour — otherwise a capable agent will implement the bug faithfully.

## 18. The controller gets things wrong too

Two of my own rulings were wrong and had to be retracted:

- I told an implementer the plan's test count was wrong. **I had miscounted**; the plan was right.
  No harm, only because the same dispatch said "do not delete a test to match the number".
- I ruled that `passed = null` should be written whenever the total was null. An implementer
  pushed back: the total is null for three reasons, and only one of them means the gate didn't
  evaluate — for the other two it *did* evaluate and *did* reject, so recording "not evaluated"
  would erase a real fault. It was right; I refined the rule.

A reviewer also corrected a construction I proposed, showing it would have been flaky because the
underlying query has no `ORDER BY` and the result map is last-write-wins.

**Lesson:** build the loop so a subagent can contradict the controller, and treat a well-argued
pushback as a signal rather than friction. The alternative is that your errors propagate with
full authority.

## 19. A wrong comment on a contract is worse than no comment

**Five instances across this project.** It is the second-most-common defect after tests that
pass against the wrong implementation, and unlike that one it is invisible to the entire test
suite — because none of these were code.

Every single one had the same shape: **a correct decision, recorded with a reason that was not
true.**

1. A float-rounding value justified by an arithmetic claim (`452.35 * 100` landing on
   `45234.999...`) that is simply false — it lands exactly on `45235`.
2. A migration comment defining a column's NULL semantics as "not evaluated because a
   prerequisite gate failed" — the one case that, after a later refinement, writes no row at all.
3. A justification asserting the spec was self-contradictory about `append-only`, disproved by
   quoting the spec: two sentences, not one, and it never claimed the uniqueness the argument
   depended on. The contradiction was in the *plan*, not the spec.
4. A classifier comment arguing a fail-closed choice on the grounds that retrying "burns another
   of the turn's five attempts" — there is no retry. `failTurn` is terminal, and the sweeper only
   ever considers `queued`/`running` rows.
5. A report recording that a lint selector "does not match BigInt `0n`", inferred from a `?? 0n`
   going unflagged. It went unflagged because that file was **out of scope**, not because the
   selector missed it. Two different causes, one observation, and the wrong one written down —
   in a codebase where bigint is the actual money type, so the recorded gap would have invited
   exactly the dangerous line it claimed was unguarded.

Note what unites 1, 4 and 5: each was an *inference from a single observation* that the author
never checked against the mechanism. The decision was reached correctly by instinct; the
explanation was reconstructed afterwards and never verified.

That is the specific failure mode. Not carelessness — **post-hoc rationalisation of a correct
call.** It is hard to catch precisely because the conclusion is right, so a reviewer skimming for
wrong decisions sees nothing wrong.

Two things worked against it:

- **Reviewers that check the claim rather than the conclusion.** Every one of the five was caught
  by someone computing the arithmetic, quoting the source, tracing the control flow, or running
  the case — not by someone reading for plausibility.
- **Making a comment a tested contract.** One implementer wired three tests that read the *live*
  database column comment and assert every reason string appears in it, that there are exactly
  three, and that the superseded wording is gone. Changing the code without shipping a migration
  now fails the suite. That is the only one of the five that could not recur.

**Lesson:** documentation a downstream consumer will act on deserves the same adversarial
verification as code. When you write *why*, check that the why describes the system as it is —
especially when you are confident, and most especially when you reconstructed the reason after
making the call.

## 20. Whole-branch review finds a different class of defect

The per-task reviews were thorough — most tasks needed a fix round, several found real bugs. The
whole-branch review still found four Importants none of them could, including the `quantity` hole
that twelve reviews had each looked directly at.

The reason is structural: a task review checks a diff against *its own brief*. Nothing in
`quantity`'s brief was violated. The defect only appears when you ask what the number means
against data captured in a *different* task.

**Lesson:** budget for it as a separate mandatory pass, on your most capable model, with the
whole diff and the spec — not as a formality after the real reviews.

## 21. Keep a ledger, and record the reasoning not just the decision

42 rulings across this branch. The ledger is what let each dispatch carry forward exactly the
constraints discovered downstream of its brief — six of them by the time Task 11 ran — and what
made the retracted rulings visible instead of quietly overwritten.

The valuable entries are not the decisions. They are the *costs*: "if this is wrong, the audit
record mislabels a real rejection as not-evaluated". That sentence is what lets someone reverse
the decision later without re-deriving why it was made.

**Lesson:** in a long agent-driven run, write down what a decision costs if it's wrong. It is the
only part that stays useful after the decision is forgotten.
