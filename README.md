# Globetrotty, the course branch

This branch holds the code for the Master AI Agents course. We build an AI travel agent one lesson at a time, and each lesson lands as a commit and a tag.

## Running a checkpoint

Every lesson ends on a tag. To run one, check it out, install, and run the tests.

```bash
git checkout lesson-1-4
npm install
npm test
```

The tests replay recorded model replies, so you do not need an API key to run them. This keeps the course fast and repeatable, and it keeps everyone's test run identical to what we recorded when we wrote the lesson.

From lesson 2.1 on, a checkpoint needs one more step before `npm test`: `npm install`, a `DATABASE_URL` in `.env.local` (see "The database" below), `npm run migrate`, then `npm test`. Skip the database step and `npm test` still passes; it just runs fewer tests.

## Running the agent live

If you want to talk to the real API instead of replayed fixtures, copy `.env.example` to `.env.local` and add your `ANTHROPIC_API_KEY`. Then run:

```bash
npm run trip
```

This calls the live API using whatever the travel agent can do at that point in the course.

## The database

From lesson 2.1 on, some tests need Postgres: they write real rows and read them
back, rather than mocking the database away. Every one of those tests is
declared with `describeDb`, so it skips cleanly when `DATABASE_URL` is unset.

To run them, point `DATABASE_URL` (in `.env.local`) at a Postgres instance. A
free Supabase project is enough: create one at supabase.com, open Project
settings, Database, and copy the direct connection string. Then apply the
course's migrations, which live in `supabase/migrations` and run in order:

```bash
npm run migrate
```

Everything the course creates lives in its own `course` schema, so it never
touches a product's tables in `public`.

## The four tiers, and the clock each one runs against

    tier 1                tier 2                      tier 3                     tier 4
    her browser           the request handler          the background function    the scheduled sweeper
    +-----------+         +-------------------+        +---------------------+    +-------------------+
    |  she      |  POST   |  submitMessage    |  POST  |  run-turn-background|    |  every five       |
    |  presses  | ------> |  writes the rows  | -----> |  .mts runs the turn |    |  minutes, it      |
    |  Send     | <------ |  and returns      |        |  and writes back    |    |  rescues turns    |
    +-----------+  turn   +-------------------+        +---------------------+    |  nobody finished  |
         ^         id            |      ^                     |        ^          +-------------------+
         |                       |      |                     |        |                   |
         | she waits             v      |                     v        |                   v
         | as long as         +------------------------------------------------------------------+
         | she likes          |                  Postgres: conversations, turns, messages         |
         +------------------- |  the only thing all four tiers share, and the only durable one    |
                              +------------------------------------------------------------------+

    tier 1  as long as she is willing to wait
    tier 2  about ten seconds, so it only writes and returns
    tier 3  fifteen minutes, which is where the turn runs
    tier 4  every five minutes, netlify/functions/sweep.mts runs src/sweeper.ts

The arrow from tier 2 to tier 3 carries `x-worker-secret`. Tier 3 is reachable by
anyone who knows the URL and it starts work that costs money, so a call without
that header is refused before its body is read. Tier 3 is a background
function, so the caller's socket gets an immediate 202 whether or not the
secret matches; a wrong secret is observed only in tier 3's own log and in
`test/tier3.test.ts`'s unit tests, never in a status code sent back to tier 2.

Tier 4 sends the same header, because it starts the same work. It requeues a
turn whose worker went silent or that nothing ever started, fails a turn that
has used up its attempts and tells her so, and fails a turn that has no message
to run so her conversation is not held shut by a turn nobody can execute.

"Went silent" is a real condition from lesson 3.6 on, because the worker loop
stamps `heartbeat_at` every twenty-five seconds while a step runs. A turn whose
worker keeps ticking is left alone however long it runs; a turn whose beat
stops is requeued ninety seconds later. The fencing token keeps a dead
worker's writes out once it loses its claim, `saveTurnState` and the rest of
`src/repo/turns.ts` included; it does not, by itself, stop a worker that is
NOT dead but has merely been superseded from still calling the model for the
rest of its own budget after the fact. `src/worker.ts`'s abort signal is the
part that answers that, and only partly: a heartbeat tick discovers the fence
and aborts the signal, but that discovery is up to one heartbeat interval
late.

Threading the signal all the way through module 1's `TurnOptions` is done, at
lesson 4.2. `TurnOptions` and `LoopOptions` both carry a `signal`, the model
client passes it to the SDK and the tool runner passes it to the supplier's
own `fetch`, so a fenced worker's in-flight model call and in-flight supplier
call are both cancelled rather than merely not being followed by another one.
Two gaps are left and neither is silent: `classify` and `extract`
(src/classify.ts, src/extract.ts) are single short calls on the cheap seat and
are not given the signal, so a fence landing during one of them still pays for
it; and cancelling a call does not un-charge it. The provider may already have
generated most of a reply and billed for it, and `callAndRecord`
(src/metered.ts) records only what came BACK, so an aborted call writes no
`course.model_calls` row, no `daily_usage` increment and no
`conversations.spend_usd_micros` increment. That charge is invisible to every
later ceiling check, and it is a real hole this lesson opened rather than one
it closed: `course.model_calls` has no column that could name a call that never
returned, so recording it needs a migration this module does not do. Module 5's
reserve-before-call, where a call is counted before it is made, is where it
closes. `fencedModelCallSink` answers the OTHER case, a call that returned into
a fence: it records that row before refusing the next call, and it never sees a
cancelled one, because a cancelled call never reaches a sink.

The attempt count is the sharper half of that same story, and it is history
now rather than an open cost: before lesson 3.6, a requeue advanced
`attempts`, and the worker re-invoked for the reissued turn advanced it again
when it claimed, so a live long turn with no ticking heartbeat spent two of
its five attempts per ninety-second tick rather than one, and could reach
`crash_loop` in about half the wall clock it otherwise would, thread and all,
while workers were still running it. Both costs closed when lesson 3.6's
worker loop started ticking a heartbeat: a live turn's own beats now keep it
out of the sweeper's stale check entirely, so neither the requeue nor its
attempt cost is paid by a turn that is simply still running.

`npm run demo` narrates the harness against a real database with no model and no
API key: a message becomes durable work, a retried press buys no second turn, a
process dies mid tool call and the resumed turn does not run the tool again, a
superseded worker is refused, and the ledger shows what it all cost. It runs
under its own user id, distinct from `npm run trip`'s, so the two can share one
database without one script's cleanup deleting the other's rows; the one thing
it does NOT scope is `sweep()` itself, which is global by design and, on a
shared database, requeues or fails every other user's stale turns too.

The supplier port arrived in lesson 4.1: a `SupplierItem` says who quoted it,
when, for how long it stays quotable and whether it can be checked again, and
`MockSupplier` answers all four honestly for a supplier that invents its prices
from a hash. One coincidence has run through the suite since then and still
does. `mockRunner` (src/tools.ts) calls `supplierRunner` with no currency, which
reads as `TRIP_CURRENCY`, so every search a test makes through it comes back in
euros, while the recorded reply `test/provenance-v0.test.ts` replays quotes
dollars. `offeredAmounts` compares whole-unit numbers and never reads the
currency code beside them, so 464 EUR and 464 USD are the same number to it and
that test passes. The helper moved to `test/helpers/provenance.ts` in lesson 4.4
and gained a second caller there, `test/tampered-price.test.ts`.

Lesson 4.5 answers the question that leaves open by RETIRING the helper rather
than teaching it currencies. `checkCurrency` (src/gates/checks.ts) is what
judges a currency now: it compares codes, it refuses instead of converting, and
it is the gate every real proposal goes through, so `offeredAmounts` is no
longer a check of anything this system does. It keeps exactly one job, which is
to be the check lesson 1.4 shipped, inside the two files that exist to show what
that check waves through. Its blindness is what makes
`test/provenance-v0.test.ts` pass, so teaching it currencies would turn that
file red and demonstrate nothing; `test/tampered-price.test.ts` does not turn on
a currency at all, since both its offers are euros and what it shows is an id
check that never looks at the values and an amount check that reads prose.
`test/regressions.test.ts` pins the retirement rather than asking for it: any
third file naming `offeredAmounts` fails there.

What the search currency below closes is a different thing, the DEADLOCK. It
does not reach this coincidence, because `mockRunner` passes no currency and
goes on searching in euros.

Two suppliers are real from lesson 4.2. Flights come from Kiwi's MCP
endpoint, which needs no key; hotels come from SearchApi's Google Hotels
engine when `GOOGLE_SEARCH_API` is set and from the mock when it is not, and
`npm run trip` prints which one it used. Both parsers are pure functions over
recorded responses, so `npm test` still needs no key of any kind and touches
no network; the two `*.live.test.ts` files are the only exception and they
skip unless `LIVE_SUPPLIERS=1`.

From lesson 4.3 every search a turn makes writes rows. `course.tool_results`
holds one row per item per fetch, untrimmed and append-only: a re-search of an
item appends a second row and the first one stays, so the corpus can answer
"what price did we see for this id, and when?" rather than only "what does it
hold now". Tier 3's driver and `npm run trip` run the same chain, so a run of
either leaves its rows behind it and prints how many; the tests that run a turn
through `mockRunner` or a bare `supplierRunner` are what still search without
recording, with `test/toolResults.test.ts` and `test/gate-rehydrate.test.ts` as
the deliberate exception, since provenance is what those two are about and they
record on purpose. A search records when it runs through `corpusRunner`, and not
otherwise. A claim is not the separator:
`test/crash.test.ts` and `test/turns.test.ts` both claim their turn and record
nothing, because they are asserting something other than provenance. The model
still reads a trimmed view of the same search and the two are deliberately not
the same object.

The write is fenced like every other write a worker makes: `recordResults`
takes the claim and appends only while the turn is still this worker's, so a
superseded worker cannot leave a price behind that would then win rehydration
for being the newest. What it costs when it does refuse is a `pending` row in
`course.tool_calls` that only a person clears, the same operator step lesson
3.4 wrote down, and a search is read-only so nothing outside the system is left
ambiguous by it.

Two costs this table has and does not pay yet. It grows without bound and
nothing prunes it; module 7's retention schedule is where that is answered. And
row isolation is not enforced on it: the composite foreign key keeps a row
attached to the right user, nothing else does, and the RLS worker role is
lesson 5.7. Both are stated on the table itself, in `0010`.

From lesson 4.4 an offer is a list of references. `ProposalRefsSchema`
(src/gates/rehydrateGate.ts) accepts `{sourceId, quantity, slot}` and rejects
any other key outright, and `rehydrateRefs` reads every field of every item back
out of `course.tool_results` and throws away whatever the caller supplied, so
there is no price field for a model to move or invent.
`test/tampered-price.test.ts` holds both halves of that: the two offers that
passed the old check, still passing it, and the same two offers refused by the
schema. "The old check" is two functions from two places, and the test says so:
the id half is the source articles' `checkProvenance`, reproduced in that file
because no such function exists at any tag here, and the amount half is
`quotedAmounts` and `offeredAmounts`, which is what lesson 1.4 actually shipped.

From lesson 4.5 a proposal goes through six deterministic gates in order:
freshness, currency, slots, totals, budget, dates, with provenance ahead of them
from lesson 4.4. Every fault comes back in one reply rather than one per model
call, and `course.gate_results` records a row for every gate that ran, passes
included, with three verdicts: true, false, and null for a gate that ran and
could not reach one, with `detail` saying which of exactly three reasons applies.
`quantity` is judged there too, by `checkTotals`, and the answer is that for
every supplier this branch ships the price already covers the whole booking, so
the only correct quantity is 1.

The search currency now comes from her budget rather than from a constant. That
is the same `currency` the gates expect, off the same object, so a corpus and
the currency gate cannot disagree by construction; `TRIP_CURRENCY` stays as the
fallback for a traveller who has named no budget and therefore no currency. Not
doing this would have deadlocked the currency gate for every trip priced outside
the euro area, which the course's own EUR example would never have shown.

Two of the six still have nothing to check against, and both say so on the row
rather than reporting a pass. The dates gate has no travel window, because this
branch's notebook carries a month and not two dates; widening it touches
`src/extract.ts` and its recorded fixtures and belongs to module 5. And on the
paths you can run, the budget gate has no budget: nothing stores a notebook, so
both drivers derive their constraints from an empty one and every live proposal
records `budget: not evaluated` with the reason. `npm run trip` and tier 3 build
the same chain here, `proposalRunner` outside `corpusRunner`, so both can
propose and both write `course.gate_results` rows; the ledger is the one layer
`npm run trip` leaves out, because it is one process with no crash to resume
from. The gate itself is exercised in `test/gate-pipeline.test.ts` through
`proposalRunner`, the same seam and the same `runGates` call both drivers make,
with a real budget in the context. Module 5.2 moves
the registry inside the harness, where the turn's own notebook is in scope, and
closes both.

From lesson 4.6 there is a cashier. It refuses unless a stored proposal row for
this conversation carries `decision = 'accept'` decided within thirty minutes;
it re-quotes every item against a supplier that says it can re-quote, and blocks
on any item it could not confirm, because unknown is not unchanged; it compares
per item, on flight numbers and currency and price basis as well as on price,
with an explicit half a percent tolerance, because a total that fell when a
refundable fare became basic economy is a downgrade she never accepted; where a
supplier says it CANNOT re-quote, it does not claim verification and the copy
becomes disclosure with the price's age; it builds every link itself from
`(supplier, sourceId, tracking ref)` against a fixed template and an allowlisted
host, minting the `link_clicks` id first and embedding it as the sub-id; and it
checks the same global ceiling lesson 2.6 built, now standing between the model
and a booking link.

Link emission is the point of no return. `course.link_clicks` rows are written
before the links are returned, and every place that could END the turn by
contradicting them reads that table first. In `src/worker.ts` that is one
helper, `failTurnUnlessLinkEmitted`, which `runTurn`'s catch and all four of
`loop`'s `failTurn` exits go through: the fail-closed spend read, `decideNext`
saying stop, an ambiguous tool call and the agent's own `fail` step. Each of
them completes the turn with the link message instead of failing it. The
sweeper's crash arm reads the same table in SQL and reaps such a turn without
writing `TURN_FAILED_MESSAGE`, sending the conversation back to `awaiting_user`.
A second hand-off is refused by the cashier itself, before it re-quotes
anything, which is the other half of the rule.

On tier 3 the emission is also `beginToolCall`-protected, because `cashierRunner`
sits inside `ledgerRunner` there. `npm run trip` is ledgerless by design, so it
is not: one process, no crash to resume from, and nothing to replay. The comment
above its chain says so.

Four residuals, all of them named where they live.

Nothing in production sets `decision`. `decideProposal` is written and tested,
and its production caller is the accept button on a proposal card, which is
lesson 5.7: this module has no surface for a person's click. `npm run demo`'s
sixth scenario answers for her in process, so the keyless proof does reach a
real link, a real `course.link_clicks` row and a real hand-off message; what is
missing is her own click, not the path behind it.

The two paths that REQUEUE a turn rather than end it do not read the table:
`continueLater`'s hand-back in `src/worker.ts` and the sweeper's requeue arm.
Neither can emit the same link twice, because the cashier refuses a second
hand-off of a proposal that already emitted and `unique (proposal_id, item_id)`
stands behind that; a restarted turn that proposes again, though, gets a new
proposal id, which that constraint does not cover. Nothing in production writes
`proposals.decision` yet, so this is not reachable today. Closing it is the
whole-branch review's, which already carries `failTurn`'s callers and `sweep`'s
arms as a question.

A worker that dies OUTRIGHT, so that even the catch does not run, leaves the
sweeper to reap the turn silently. Her links exist, in `course.link_clicks`, and
she was never shown them; reading them is an operator step, like the `pending`
tool-call row from lesson 3.4.

The affiliate id in every link is a placeholder, not an account.

## What is next

`LESSONS.md` lists every checkpoint tag next to the lesson it belongs to and the proof that lesson is done. Start there if you want to jump ahead or replay a specific lesson.
