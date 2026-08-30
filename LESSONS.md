# Checkpoints

Every lesson of the course ends on a tag. Check the tag out, install, and run the proof.

| Tag | Lesson | Proof |
|---|---|---|
| lesson-1-1 | The first call | npm test, then npm run trip with a key |
| lesson-1-2 | Seats | npm test (test/cost.test.ts prints both bills) |
| lesson-1-3 | Reading her numbers | npm test (test/extract.test.ts) |
| lesson-1-4 | The first tool | npm test (test/provenance-v0.test.ts) |
| lesson-1-5 | Bounding the loop | npm test (test/loop.test.ts) |
| lesson-1-6 | Two desks | npm test (test/desks.test.ts) |
| lesson-1-7 | The notebook | npm test (test/notebook.test.ts, test/conversation.test.ts, test/crash.test.ts) |
| lesson-2-1 | Persist first | npm run migrate, then npm test (test/crash.test.ts, test/handler.test.ts) |
| lesson-2-2 | Four tiers with a clock each | npm test (test/tier3.test.ts) |
| lesson-2-3 | Engine and shell | npm test (test/engine.test.ts, test/loop.test.ts) |
| lesson-2-4 | Money is never a bare number | npm test (test/cashier.test.ts, test/money.test.ts) |
| lesson-2-5 | Record every call | npm run migrate, then npm test (test/model-calls.test.ts, test/alias-echo.test.ts) |
| lesson-2-6 | Control the money | npm run migrate, then npm test (test/spend.test.ts) |
| lesson-2-7 | Fifty presses, one turn | npm run migrate, then npm test (test/idempotency.test.ts) |
| lesson-3-1 | The claim with a fencing token | npm run migrate, then npm test (test/claim.test.ts) |
| lesson-3-2 | Heartbeats and leases | npm run migrate, then npm test (test/lease.test.ts) |
| lesson-3-3 | Completion in one transaction | npm run migrate, then npm test (test/completion.test.ts) |
| lesson-3-4 | The tool-call intent ledger | npm run migrate, then npm test (test/tool-calls.test.ts, test/crash.test.ts) |
| lesson-3-5 | The sweeper | npm run migrate, then npm test (test/sweeper.test.ts) |
| lesson-3-6 | The worker loop assembled | npm run migrate, then npm test (test/worker.test.ts, test/retry.test.ts), then npm run demo |
| lesson-3-7 | Building the harness with agents | npm run migrate, then npm test (test/regressions.test.ts) |
| lesson-4-1 | The supplier port | npm test (test/supplier-types.test.ts, test/supplier-mock.test.ts, test/supplier-dates.test.ts) |

## How this branch was built

Seven lessons, one tag each, and a review between every one of them. What the
reviews actually caught, and what it cost to catch it:

**Tests that pass against the wrong implementation.** The commonest defect in the
whole build, by a distance. A fifty-press test that pressed against a
conversation that already existed, so the broken key scope was never exercised.
A spend test that read a number it had not written. A completion test that threw
on its first statement, so an unbatched implementation would have passed it too.
What found them was not reading the test. It was writing the wrong
implementation and checking that the test actually fails: `test/regressions.test.ts`
carries the three that reached a tag, and the plan for each one says to break it,
watch it fail, restore it, and paste both outputs.

**Evidence, not assertions.** "I added a test that discriminates" is worth
roughly nothing between two agents. A pasted failing output is worth a great
deal. Every fix round in this module ends with a command and its output.

**A wrong comment on a contract is worse than no comment.** Every instance had
the same shape: a correct decision recorded with a reason that was not true. A
docstring claiming a partial index cannot be a conflict target. A comment
promising that `finishTurn` records a reason for every outcome when it recorded
one for some. The decision was right and the explanation was reconstructed
afterwards and never checked, which is why a reviewer skimming for wrong
decisions sees nothing wrong. Check the claim, not the conclusion, and prefer a
contract a test can read: `test/regressions.test.ts` asserts the idempotency rule
out of the Postgres catalogue rather than describing it in a comment.

**A whole-branch review finds a different class of defect.** A task review checks
a diff against its own brief, and nothing in the brief was violated. The defects
that only appear when you ask what a number means against data written in a
different task need the whole diff and the whole spec, on the most capable model
available, as a separate mandatory pass rather than a formality at the end.

**A ledger, with the cost of being wrong.** Every ruling is written down, and the
valuable part is not the decision. It is the sentence that says what it costs if
it is wrong, because that is the only part still useful after everyone has
forgotten why the decision was made.

## Hand-offs

Closed at lesson 3.5: the `queued` turn with no message that two presses of one
key could leave behind is reaped as `stalled`, and its conversation goes back to
`active` so she can type again. `test/sweeper.test.ts` asserts the whole of it,
including the `queued` she gets from the press that follows.

Closed at lesson 3.5: a turn stranded at `running` by a driver throw, with the
claim's heartbeat already set, is requeued once that heartbeat goes stale by
the heartbeat arm of `stale` (`test/sweeper.test.ts`, "requeues a turn whose
worker went silent"), and once its attempts are used up it is failed as
`crash_loop` with a sentence she can read, so a database outage ends in an
answer rather than a spinner.

Closed at lesson 3.5: a turn failed `ambiguous_tool_call` (lesson 3.4) is
`failed`, which sits outside both arms of `stale`, so the sweeper never retries
it. The `pending` row it leaves behind in `course.tool_calls` is an operator
step, not a sweeper job: run `select * from course.tool_calls where status =
'pending'`, decide from the tool's own record whether the call actually
landed, and delete the row by hand.
