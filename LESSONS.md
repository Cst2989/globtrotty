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
| lesson-5-3 | The front desk and the planning desk | npm run migrate, then npm test (test/desk-routing.test.ts, test/sentinels.test.ts, test/desks.test.ts) |
| lesson-5-4 | Staff | npm run migrate, then npm test (test/scout.test.ts) |
| lesson-5-5 | Fence text you did not write | npm test (test/injection-corpus.test.ts, test/outbound.test.ts) |
| lesson-5-6 | Memory and context | npm run migrate, then npm test (test/cache.test.ts, test/memory.test.ts), then LIVE_MODEL=1 npm test for the canary |
| lesson-5-7 | What she sees | npm run migrate, then npm test (test/channel.test.ts, test/isolation.test.ts, test/capture.test.ts, test/monitor.test.ts), then npm run trip for the offer card |
| lesson-6-1 | Why snapshot tests lie | npm test (test/eval-snapshot.test.ts, test/grade.test.ts, test/scorecard.test.ts), then npm run evals for the first scorecard, which exits 1 because one of its two worlds is graded red on purpose |
| lesson-6-2 | The gates are already evals | npm run migrate, then npm test (test/eval-replay.test.ts, test/gate-metrics.test.ts), then npm run evals for the card with its gate rows |
| lesson-6-3 | Golden trips and the simulated traveller | npm run migrate, then npm test (test/golden-cases.test.ts, test/sim-user.test.ts, and test/eval-run.test.ts, which takes about four minutes against a remote database and seconds against a local one), then npm run evals for three cases driven end to end |
| lesson-6-4 | Pinning variance | npm run migrate, then npm test (test/variance.test.ts, test/eval-limits.test.ts), then npm run evals -- --runs 3 for pass^k over three pinned runs |
| lesson-6-5 | Trajectory grading | npm run migrate, then npm test (test/trajectory.test.ts, test/turn-labels.test.ts), then npm run evals for rates with denominators |
| lesson-6-6 | The judge | npm run migrate, then npm test (test/judge.test.ts, test/eval-schedule.test.ts; test/judge.live.test.ts reports SKIPPED without LIVE_MODEL=1), then npm run evals |
| lesson-7-1 | The signal we already collect | npm run migrate, then npm test (test/conversions.test.ts, test/writers.test.ts, test/signals.test.ts) |
| lesson-7-2 | Three requirements | npm test (test/derive.test.ts), then npm run typecheck |

## How this branch was built

Module 3's seven lessons, module 4's six and module 5's seven, one tag each, and
a review between every one of them. The count is corrected here at lesson 5.7,
the last of the three modules, because the bullets underneath it grew through
module 5 while the sentence above them still said two modules. What the reviews
actually caught, across all three, and what it cost to catch it:

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

**One fixture, recorded on purpose, and the reason written down.** Module 4
recorded nothing and module 5 records exactly one reply: a scout's brief, in
`test/fixtures/model/scout-faro.json`. Everything else in this module is
hand-written in `test/model/fake.ts` or is a pure assertion over an assembled
request. The brief is recorded because the claim being tested is that a REAL
model's prose is untrusted text, and a brief we wrote ourselves would be
untrusted text from a trusted author, which proves nothing about the fence. It
was re-recorded once, under the same name, when the scout prompt started being
read through the desks' comment-stripping loader: the bytes in the `system`
field changed, and a fixture whose request is not the request the code sends is
a contract with a past that never happened. Re-recording to fish for a nicer
reply would be the other thing, and is not what happened: the brief still
declines, for the reason it declined the first time.

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

**An attack corpus is written before the defence, and the report says which
cases already passed.** All six of the payload attacks `test/injection-corpus.test.ts`
loops over were green against the fixed delimiter lesson 5.2 shipped, because
the escaping was already right, and the twenty cases the file holds today grew
around them. Writing that down is the difference between "we added a nonce and
the tests pass" and knowing that the nonce is defence in depth rather than a
repair, which is the only version of the claim worth putting in a lesson.

**A blocklist and an allowlist, chosen per surface rather than by preference.**
The URL check is an allowlist because the agency emits exactly one kind of link
and everything else is wrong by construction, which is also why it compares whole
links and not hosts: one of the hosts it builds links on serves an image
endpoint and an open redirect too. The solicitation check is a blocklist because
the REQUESTS it catches have no legitimate instance here: the agency never takes
a payment, holds a document or verifies an identity, so there is no true positive
to weigh against a false one. The words those requests are made of are a
different matter, and a first version that matched them fired on six of seven
ordinary travel sentences, which is how a blocklist gets turned off.

**A default parameter is how a one hour write silently bills at the five minute
rate.** `costMicros`'s TTL argument is required. Making it optional with a
`'5m'` default would leave every call site that forgot it under-billing by sixty
percent, and an under-count is the dangerous direction precisely because
nothing surfaces it: no error, no failing test, and a number that looks like a
number. The compiler is what found them: eight call sites in `src/`, across
seven files, one of them in `src/ask.ts`, a file this module touches for no
other reason, and every test that prices a call of its own on top of those.
Counting files rather than call sites is how a list like that comes out one
short, since `src/classify.ts` prices twice. That is the whole point of adding a
required parameter rather than reading a field from a constant: the inventory is
produced by the typechecker and not by somebody's memory of where the function is
called.

**A security control that disables a money control is not an improvement.** Row
level security on `course.daily_usage` would have made the global daily
ceiling's cross-user sum return one user's rows, so the ceiling would have
stopped firing with no error anywhere. The two tables that carry money stay
owner-read and every table that carries a traveller's own rows carries a policy,
and `test/isolation.test.ts` asserts both halves, including that the global sum
is still global.

**Anything that captures model input and output is a credential exfiltration
path by default.** `redactCredentials` runs before serialisation and the result
is parsed back to an object, and the case that motivates the design is a
credential nested inside a content block, which a top-level scan would never
find. That case rested on code inspection until it got a test here.

**A cleaner named for one kind of string will be reached for by the next.**
`sanitizeSourceId` was narrowed to an allowlist of `[A-Za-z0-9_-]` in lesson
5.5's fix round, which is exactly right for an id, and lesson 5.7's plan then
called it on a supplier's NAME as well, where it would have printed "Beachfront
apartment, Faro, 7 nights" on her card as one unreadable word. Two strings that
both come from a supplier are not therefore the same kind of string, and the card
cleans them differently for reasons written at the function that does it.

**A ceiling for the tests is not the same object as a ceiling for her.**
`EVAL_LIMITS` sits beside `DEFAULT_LIMITS` in one file rather than being a set
of numbers an eval script invents, and the one ceiling it does not touch is the
cross-user global one, because loosening that for a test suite loosens it for
production. Every eval conversation still moves money through the same four
functions, and there is no fifth. The first draft of it was tight enough to stop
the longest case two model calls short of the end of its own recording, which is
a suite measuring its budget rather than its agency, so the number in the file is
the one a measurement chose.

**Two constants holding the same string today are not one constant.**
`EVAL_TODAY` is the suite's calendar and `TODAY` is the reader's, and they both
say 2026-08-29. They are separate because they move for unrelated reasons: the
day a lesson needs a different date in a transcript, every golden case that says
"the second half of September" would have been silently re-dated by an edit
nobody connected to the evals, and the suite would have kept passing while
measuring a different trip.

**Half a pin is worse than no pin.** The first version of that split reached the
gates and not the desk: `makeDriver` still rendered `{{today}}` from module-scope
`TODAY` while `constraintsFromNotebook` read `EVAL_TODAY`, so the day those two
parted company the desk would have planned one year and the dates gate judged
another, and the gate would have failed proposals the desk was right to make.
With one constant nothing was wrong, which is why nothing was red. `today` is a
required field on `DriverDeps` now, every production caller passes `TODAY`, and
the eval chain passes its own.

**A pinned clock is domain time, and a deadline is not domain time.** Freezing
`now` for the fares, the gates and the notebook also froze the two places that
measure how long the process really worked: `deadlineMs() - now()` became a
constant no turn could ever reach, and every `course.model_calls` row an eval
wrote claimed a latency of zero. The deadline had been unreachable before the
freeze as well, by a second route, because it was recomputed from the current
instant on every read rather than anchored at the start of the invocation. One
function returns both clocks now and says which question each answers.

**A replay against the live state is not a replay.** The gates and the evals
share one implementation, which is the strongest guarantee in this repository,
and it held only until the notebook was allowed to move underneath it. One
column written at save time is the whole fix, and it could not have been added
later: the prior notebook states were overwritten in place and no history of
them exists anywhere in this schema.

**A judge with no calibration is a number, and a number is not a decision.**
`judgeAgreement` compares the judge against her own accept and reject rows and
refuses to call it deployable under eighty percent, and an empty calibration set
does not meet the floor either, because zero of zero is a calibration nobody
performed. The arithmetic is pinned over a hand-written table rather than over a
recording, for the reason a recorded verdict pins the parser and nothing else.
The judge itself reserves and reconciles like any other conversation, under the
eval ceilings rather than hers, so the night it runs is bounded by the same four
functions that bound a turn and there is no fifth writer of the ledger.

**The instrument was never the missing half; the trigger was.** Lesson 5.6's
canary pins one prompt at one seat and fires when somebody runs it. What catches
a provider moving weights under a stable alias is a score that falls on a clock,
which is why the schedule is a table this repository can select from rather than
a paragraph about what one would do before a migration.

**A seat that grades the thing it is cannot be trusted to grade it.** The judge
runs on `SEATS.reviewer`, Haiku with no effort and 1,024 tokens, against the
driver's Opus at high effort with 16,000, so the two differ by model, by
configuration and by `model_config_id`. That is as far as one provider's key
reaches: the finding the rule comes from is about the FAMILY, and README.md
carries the rest of it as a residual rather than as a claim this branch can
make.

**A click is not a conversion.** The cashier minted the tracking ref before it
built the URL at lesson 4.6, and this lesson created the table those refs land
on before there was a single row to put in it, because the join key is the one
thing that cannot be added later. What it deliberately did not build is the
number that was already available: `clicked_at` measures whether a link looked
worth opening.

**Enumerate every writer of a table before designing one.** LL3 section 21:
two duplicate writers shipped in one plan, both invisible to every test, because
no test exercised the seam. test/writers.test.ts is that test, as a grep over
src/, and it is four lines of assertion for a defect class that has cost more
than any other on this branch.

**A number derived from nothing is not a zero.** `DerivedScore` is a union whose
third arm carries no value at all, so `score.value ?? 0` does not compile.
P4 names the accidental `?? 0` as the usual shape of this bug. On this branch
the compiler names it instead, and `valueOr` is the one door a caller goes
through when it really must have a number, with the decision visible at the call
site rather than buried in an operator.

**Every derived number carries the rows that produced it.** Including the
absent one, whose rows are the empty list, which is a fact and not a gap.

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

Closed at lesson 5.7: `proposals.decision` is written in production. The accept
action on the proposal card calls `decideProposal`, `npm run trip` reaches a
real booking link through a real decision, and `npm run demo`'s sixth scenario
answers through the card rather than in process.

Open at lesson 5.7, and reachable from lesson 5.7: the two paths that REQUEUE a
turn rather than end it still do not read `course.link_clicks`. They are
`continueLater`'s hand-back in `src/worker.ts` and the sweeper's requeue arm,
and they are the unenforced half of module 4's headline invariant. What changed
here is not the code on those paths, which is untouched, but the world around
them: 4.6 could say the second set of links for one trip was unreachable because
nothing in production wrote `proposals.decision`, and the accept action on the
card writes it now. A requeued turn that proposes again gets a new proposal id,
which `unique (proposal_id, item_id)` does not cover. Closing it means deciding
what a requeue owes a turn that has already handed off, which is a harness
question rather than a channel one. Owner: module 6, which also owns the one
turn the sweeper's crash arm can leave alive-looking, for the same reason 4.6
handed these two over together.

Open at lesson 5.3: `classifyDesk` (src/classify.ts) takes no `AbortSignal`.
`callAndRecord` accepts one and the routing call passes none, so the first model
call of every step 0 is the one call on the deployed path a fence cannot cancel:
a fenced turn keeps it in flight and still writes its reconcile, its
`course.model_calls` row and its desk afterwards, against a conversation another
worker is now driving. It is one Haiku call against a one-line prompt with a
1,024 token ceiling, which is the whole reason it is named instead of fixed
here. The fix is one parameter. Lesson 5.6 threaded a new required argument
through `src/classify.ts`, `src/metered.ts` and every other call site of
`costMicros` and did not add the signal with it, so the exposure is unchanged and
only its owner has moved. Owner: lesson 5.7.

Open at lesson 4.6: the affiliate id inside every emitted link is one
placeholder shared by all three templates, not a per-supplier account. The shape
of the URL is right and the value is obviously not live. It is never read from
the environment, because a missing value would silently emit an unattributed
link rather than failing.

Closed at lesson 5.3: the front desk is back on the deployed path. `selectDesk`
(src/agents/driver.ts) classifies once per turn and writes the answer to
`course.conversations.desk`, a column 0001 created and nothing had ever read.
Once per TURN and not once per step counter: `withRetry` wraps the whole agent
step and a resume whose state write was lost comes back on step 0, so the
decision is recognised by the turn's own `front_desk` row in
`course.model_calls` rather than by the column, which is `not null default
'planning'` and cannot say "nobody has decided". A factual question is answered on Haiku at a fifth of the price, and
`test/desk-routing.test.ts` asserts both calls of an FAQ turn carry
`seat = 'front_desk'` in course.model_calls.

Closed at lesson 5.3: `ask_user` is published to the planning desk and answered
only by the driver, which ends the turn on her question. `npm run trip` ran
`turn()` and `toolLoop`, which have no step that parks a turn on a question, so
on that path the tool came back to the model as an error result. That script now
builds `makeDriver` and `runTurn`, the same two pieces tier 3 builds, and a live
run of it ends on her three questions. `test/desks.test.ts` still names the
exemption rather than deriving around it, so the day a wrapper is expected the
list says who was meant to answer.

Withdrawn at lesson 5.3: this residual said migration `0006`'s comment on
`course.tool_calls.call_id` had been made false by lesson 5.1, and owed a
comment-only migration to correct it. The comment is true. Lesson 5.1's own fix
round restored the positional key (`s${step}-b${blockIndex}`,
src/agents/driver.ts) and the driver uses the provider's `toolu_` id only for
the `tool_result` block it pairs with, which never reaches the ledger. Nothing
is owed. The residual was written against the pre-fix shape and is the defect
class this file already names: a note about the system that describes a version
of it that no longer exists.
