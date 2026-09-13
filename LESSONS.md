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
| lesson-4-2 | Live adapters | npm test (test/supplier-kiwi.test.ts, test/supplier-searchapi.test.ts), then LIVE_SUPPLIERS=1 npm test for the two live files. Kiwi needs no key; the SearchApi file skips, and prints why, without GOOGLE_SEARCH_API |
| lesson-4-3 | The provenance corpus | npm run migrate, then npm test (test/toolResults.test.ts, test/schema-corpus.test.ts) |
| lesson-4-4 | The rehydration gate | npm run migrate, then npm test (test/tampered-price.test.ts, test/gate-rehydrate.test.ts) |
| lesson-4-5 | Freshness, currency, slots, totals, budget, dates | npm run migrate, then npm test (test/gate-freshness-currency.test.ts, test/gate-totals-budget-dates.test.ts, test/gate-pipeline.test.ts) |
| lesson-4-6 | The cashier | npm run migrate, then npm test (test/cashier.test.ts, test/cashier-links.test.ts, test/point-of-no-return.test.ts), then npm run demo for scenario 6, which reaches a booking link with no API key |
| lesson-5-1 | The driver in the harness | npm run migrate, then npm test (test/request-shape.test.ts, test/driver.test.ts, test/resume.test.ts) |
| lesson-5-2 | Tools are doors | npm run migrate, then npm test (test/registry.test.ts, test/doors.test.ts, test/notebook-repo.test.ts) |

## How this branch was built

Module 3's seven lessons and module 4's six, one tag each, and a review between
every one of them. What the reviews actually caught, across both, and what it
cost to catch it:

**Tests that pass against the wrong implementation.** The commonest defect in the
whole build, by a distance. A fifty-press test that pressed against a
conversation that already existed, so the broken key scope was never exercised.
A spend test that read a number it had not written. A completion test that threw
on its first statement, so an unbatched implementation would have passed it too.
What found them was not reading the test. It was writing the wrong
implementation and checking that the test actually fails: `test/regressions.test.ts`
carries the three that reached a tag, and the plan for each one says to break it,
watch it fail, restore it, and paste both outputs.

**A defence with no reachable caller defends nothing.** `applyRequirements`
refused a tool-sourced relaxation of a budget from lesson 1.7, it was tested,
and no production call site could reach that branch, because the only caller
passed `'user'` unconditionally. The test that found it is not a unit test of
the function: it reads `src/conversation.ts` and asserts what the call site
passes. Provenance is now derived from whether the turn has already ingested a
tool result, which is a fact about the transcript rather than a constant
somebody chose, and the guard was widened from `source === 'tool'` to every
source that is not hers, because the harness stamps `'user'` or `'inferred'` and
never `'tool'`: a guard naming one of the three would have gone on defending
nothing while the module claimed it did.

**A schema the model reads is not a check.** `update_requirements` published
`patch` as a free record, which is the right thing to publish, and nothing
validated what came back. The model does not have to be adversarial for that to
end a conversation: told to send `{minor, currency}`, a model reasoning in whole
euros writes `1.5e3`, which survives the write and then throws in `BigInt` on
every later read, so the notebook cannot be loaded and every future turn on that
conversation dies before the model is called. The published schema is what the
model reads; the check is a separate schema, on the way into the one function
that writes, and it refuses a patch by answering the model rather than by
throwing, because a throw past a wrapper that has already written the `pending`
row leaves a row for a person to clear.

**Evidence, not assertions.** "I added a test that discriminates" is worth
roughly nothing between two agents. A pasted failing output is worth a great
deal. Every fix round in both modules ends with a command and its output.

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

**A fixture is a contract with the past.** Module 4 replaced the supplier mock
and could not change one price, because a recorded model reply from lesson 1.4
quotes twelve of them and there is no API key in a test run to record a new one.
The port is main's; the arithmetic is lesson 1.4's, expression for expression. A
test in `test/supplier-mock.test.ts` pins all twelve amounts that fixture
depends on, across all four of the searches it drove, so the day somebody tidies
the hash the failure names the hash and not a provenance check three files away.

**The check that was green for three modules.** `test/provenance-v0.test.ts`
passed at every tag from lesson 1.4 and it does not do what its name says: it
asks whether a number was seen, never which item it belonged to, and it compares
amounts with no currency at all. Nothing found that by reading it. What found it
was writing the offer that passes it, which is in `test/tampered-price.test.ts`
and is still green, because the check was not wrong about what it checks. The
answer was to take the weight off it rather than to fix it: an offer stops
carrying amounts, and lesson 4.5's currency gate judges a currency.

**Adopting code means re-reading its comments.** Every file taken from `main`
arrived with comments describing main's schema, main's notebook, main's plan
history and main's tiers. Two in `src/gates/types.ts` asserted, in the present
tense, that a test file and a database column existed which this branch did not
have for another lesson. A comment that is true there and false here is the
defect class this file already names as the worst one, and the only way to catch
it is to check each claim against the branch it is landing on.

**A correction to an audit contract is a commit, not a rewrite.** Migration 0005
said two functions write `turns.spend_usd_micros` and three do, from lesson 3.7
on: `releaseForContinuation` grew its `spend_usd_micros = spend_usd_micros + ...`
in that lesson's fix round, and `git show lesson-3-6:src/repo/turns.ts` has no
spend in it at all. Migrations are byte-identical after their tag, so 0011
corrects it and 0005 stays wrong in the history, which is what a history is for.
0011's own `--` header dates the change to 3.6, one lesson early, and it stays
that way for the same rule that produced it: a migration is frozen after its
tag, the wrong line is a comment that is never applied to a database, and
editing it to be right would break the thing the file exists to demonstrate.

**Audit the catalogue, never a list of tables.** Lesson 4.6's schema test asks
Postgres which foreign-key child columns have no index leading on them, rather
than naming the tables it expects to be clean. It failed on its first run, and
not on anything module 4 wrote: `course.model_calls.turn_id` had been unindexed
since lesson 2.5, so deleting a turn scanned every model call ever recorded. A
hand-kept list would have been written by the same person who wrote the
migration, and would have listed exactly the tables that person was already
thinking about.

**Count the doors that move money, by name.** Four functions move
`course.conversations.spend_usd_micros` and `course.daily_usage.cost_micros`:
`recordSpend`, `ledgerSink` (which calls it), `reserve` and `reconcile`. A model
call charges through exactly one of those paths, never both, and
`src/repo/spend.ts` says so on `recordSpend` itself. The comment it replaced
claimed `recordSpend` was the only writer, and it was true when it was written,
which is what makes this class of defect so hard to see: nobody wrote a false
comment, somebody wrote a comment that a later lesson made false.

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

Closed at lesson 4.6's whole-branch fix: a worker that dies outright, so that
even `runTurn`'s catch does not run, leaves the sweeper to end the turn, and the
sweeper now ends it the way the worker would have. Its crash arm calls
`completeIfLinkEmitted` (src/worker.ts) rather than carrying a second copy of
the decision in SQL, so a turn that emitted is `done` with the hand-off sentence
rebuilt from her own `course.link_clicks` rows and the conversation parks on
`awaiting_user`. It used to be reaped `failed, crash_loop` and merely not told
about, which is a weaker promise than rule 6 states.
`test/point-of-no-return.test.ts` holds both halves, including the `queued` turn
at the cap that `completeTurn`'s own fence would have skipped. The one case it
cannot close is a turn that handed off twice in two currencies, which
`handOffMessage` cannot total; that turn is logged and left for the next walk
rather than failed, and README.md names it.

Open at lesson 4.6: nothing in production writes `proposals.decision`. The
accept button is a person's click on a proposal card, which is lesson 5.7.
`decideProposal` exists and is tested directly, `test/cashier.test.ts` calls it
in its own fixture, and `npm run demo`'s sixth scenario calls it in process so
the keyless proof reaches a real booking link rather than a refusal. What is
missing is her click, not the path behind it.

Open at lesson 4.6: the two paths that REQUEUE a turn rather than end it do not
read `course.link_clicks`. They are `continueLater`'s hand-back in
`src/worker.ts` and the sweeper's requeue arm, and this is the unenforced half
of the module's headline invariant, which is why it is worth naming here rather
than only in README. Neither can emit the same link twice today: the cashier
refuses a second hand-off of a proposal that already emitted, and `unique
(proposal_id, item_id)` stands behind that. A requeued turn that PROPOSES again
gets a new proposal id, which that constraint does not cover, so the second set
of links for one trip becomes reachable the moment something in production
writes `proposals.decision`. That is lesson 5.7, the accept button, and it is
the same lesson that makes the first residual above reachable. Whoever writes
5.7 owns both.

Open at lesson 4.6: the affiliate id inside every emitted link is one
placeholder shared by all three templates, not a per-supplier account. The shape
of the URL is right and the value is obviously not live. It is never read from
the environment, because a missing value would silently emit an unattributed
link rather than failing.

Open at lesson 5.1: the front desk is unreachable on the deployed path.
`makeDriver` loads the planning desk unconditionally, so `classify`'s routing,
which tier 3 got through `turn()`, is not on the path a deployed turn takes. An
FAQ is answered by the Opus seat and is billed at Opus rates. Lesson 5.3 moves
desk selection into the driver and persists it on `course.conversations.desk`,
which is a column `0001` created and nothing has ever read.

Open at lesson 5.2: `ask_user` is published to the planning desk and answered
only by the driver, which ends the turn on her question. `npm run trip` runs
`turn()` and `toolLoop`, which have no step that parks a turn on a question, so
on that path the tool comes back to the model as an error result. Lesson 5.3
puts the script on the driver and closes it. `test/desks.test.ts` names the
exemption rather than deriving around it, so the day a wrapper is expected the
list says who was meant to answer.

Open at lesson 5.2: migration `0006`'s comment on `course.tool_calls.call_id`
says the id is derived from the call's POSITION in the turn and never from the
model's `toolu_` id. Lesson 5.1 made that false on the deployed path: the driver
keys on the provider's id, because a persisted transcript replays the same one.
Migrations are append-only and byte-identical, and this module's one migration
slot per lesson is spent, so the correction is a comment-only migration a later
lesson owes, on the precedent `0011` set.
