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
it; and, on the `turn()` path, cancelling a call does not un-charge it. The
provider may already have generated most of a reply and billed for it, and
`callAndRecord` (src/metered.ts) records only what came BACK, so an aborted
call there writes no `course.model_calls` row, no `daily_usage` increment and
no `conversations.spend_usd_micros` increment. `fencedModelCallSink` answers
the OTHER case, a call that returned into a fence: it records that row before
refusing the next call, and it never sees a cancelled one, because a cancelled
call never reaches a sink.

From lesson 5.1 the model runs inside the harness. One invocation of the driver
is one model call plus, if the model asked for one, one tool execution, so a
turn that runs out of wall clock is handed back with its transcript in
`course.turns.state` and the next invocation picks the conversation up rather
than starting it again. The transcript holds the blocks the API accepts, a
`tool_use` block with its id and its structured input, a `thinking` block with
its signature, and a `tool_result` inside a user message that names the call it
answers, so a resumed turn sends what the previous worker was actually saying.

A call is now counted before it is made. `reserve` debits an upper bound against
`course.conversations` and `course.daily_usage`, the ceiling check reads the
numbers that debit returned rather than numbers from before the turn, and
`reconcile` applies the difference afterwards, which is normally a refund. That
closes the hole lesson 4.2 opened and named: a cancelled call used to be billed
by the provider and recorded nowhere, and it is now debited before it leaves.
Four functions move the spend ledger and `src/repo/spend.ts` names all four.

From lesson 5.3 the driver picks the desk. One cheap-seat call per turn asks for
a structured label against a published JSON schema, the answer is written to
`course.conversations.desk`, and everything after it reuses that decision: every
later step, every retry of a step, and a resume that comes back on step 0. What
recognises a decision already taken is the turn's own `front_desk` row in
`course.model_calls`, not the column, because `desk` is `not null default
'planning'` (migration 0001) and a row nobody has written reads exactly like a
row that was written planning. The routing call reserves and checks the ceiling
before it dispatches, the same way every other call does, so a capped
conversation does not still buy one Haiku call per turn.

Any parse failure routes to the planning desk, and the failure is logged: a rate
that climbs is how a model update that changed the way it answers a schema shows
up. Nothing durable carries the label, so the question "how often did the
structured output fail?" is answered from logs rather than by SQL, which is a
smaller claim than this file used to make. What the parse failure is NOT is the
label `other`, which is a real answer and must not double as "we could not read
the reply". Planning is the safe side rather than the cheap one: the front desk
holds no tools, so a trip request misrouted to it cannot be planned and she is
asked to rephrase something she phrased correctly, while a factual question
misrouted to planning is answered correctly and costs five times as much.

`npm run sentinels` greps `src/`, `netlify/` and `public/` for the service role
key, a literal `sk-ant-` key, a `NEXT_PUBLIC_` variable carrying a secret, and
the three prompts' own sentinel lines: the two desks', and from lesson 5.4 the
scout's. Those sentinel lines are HTML comments, and `loadPrompt` strips every
comment out of a prompt before it is assembled, which is the loader all three go
through, so the string the check calls undeployable is not in the bytes we send
either: the grep reads files, and the one exfiltration path a prompt really has
here is the model repeating its instructions into a reply. It runs inside `npm test` as well as
on its own, so a leak fails the suite rather than a deploy step somebody can
skip. The leak the source articles describe, a prompt pulled into a client
bundle by one helper import, belongs to a build this repository does not have:
there is no bundler and no build step here, so the grep runs over what is
actually deployed instead of over a bundle that does not exist.

`npm run trip` runs the driver now, the same one tier 3 runs, so a live run
shows the desk it chose, the seat every call was made on, and the reservation
against the reconciliation. `src/conversation.ts`'s `turn()` is still here and
is still what `test/conversation.test.ts` and the recorded fixtures from modules
1 and 2 replay; it is the one-process path those lessons built and it is not the
production one. Module 6 retires it, because its evals drive the driver.

From lesson 5.4 the agency has staff. `research_destination` sends up to three
scouts at once, each on the Haiku seat with no tools and no way to reach the
traveller, each reading one city's results and handing back a few hundred words
of prose with no price and no source id in them. The driver reads three briefs
instead of three supplier payloads, and it re-reads the briefs rather than the
payloads on every remaining step of the turn, which is where most of the saving
is.

The payload is real, and fetching it is what the tool is for. `scoutRunner`
runs one hotel search per city, after the batch is reserved and before any scout
is dispatched, against the same supplier pair the driver's own searches and the
cashier's re-quote are handed, rendered by `itemForModel` exactly as
`search_hotels` renders it. The stay comes
off her notebook, because the tool carries a city and a question and no dates
and a hotel search needs some; a month she has not named is scouted a month out
for a week, and a party size she has not stated is one adult. A scout handed an
empty data section would answer from what the model remembers about Faro, under
a fence labelling it text an external source returned, and would save nothing at
all. Nothing those searches return is recorded: a scouting payload is read once,
by one Haiku call, and no gate ever has to rehydrate it, so `course.tool_results`
stays the record of searches the driver actually made.

Those searches count against the turn's supplier budget, one per city. A
fan-out reaches the same rate-limited and sometimes billed hotel supplier
`search_hotels` reaches, so three cities is three searches out of the six a turn
may make, and the driver refuses a fan-out with more cities than the turn has
left before the runner is reached at all. The refusal is a sentence the model
can act on, naming what the call wanted and what is left, and it writes no
`course.tool_calls` row, so a refusal never consumes the quota it was refused
for. A fan-out that already ran is priced from its one row at three, the most
cities the schema admits, because the row records no input and cannot say how
many it asked for; that overcounts a one-city fan-out, which refuses a search
that would have fitted rather than admitting one that would not.

One reservation covers the batch, taken before the first call leaves, and before
any city is searched. The order matters both ways: a fan-out the conversation
cannot afford comes back `limit_reached` having asked no supplier anything, and
the payload nobody has fetched yet enters the reservation as a stated allowance
rather than as a measurement. A per-call
check is not a bound on a fan-out: three calls dispatched together each read a
counter the other two have not moved, so a conversation with room for two used
to admit all three and cross its ceiling by a whole call. Each reply is
reconciled on its own as it lands, so a small brief returns its refund without
waiting for its slowest sibling.

The batch comes back inside one fence, with a plain heading per city inside it.
`research_destination` stands behind a `worker` door, so `doorRunner` wraps the
whole result, and one wrapper is enough because the escape runs over the entire
payload: a brief that repeats the closing delimiter has it escaped along with
everything else and cannot end the fence around its two siblings. Fencing each
brief separately would be worse rather than better, because the outer escape
would eat the inner delimiters and hand the driver three broken fences. The
delimiter is still a fixed string here, which is the shape lesson 5.5 attacks.

Scout call ids are the parent call's id with `-scout0`, `-scout1` and `-scout2`
on the end, and that parent id is the driver's own POSITIONAL ledger id,
`s<step>-b<block>`, never the provider's `toolu_` id, which rides on the
transcript and never enters the runner chain. In production they read
`s3-b0-scout0`. That is also what makes them survive a resume, for the opposite
reason to the obvious one: a provider mints a fresh `toolu_` id every time it
answers, including its answer to a re-ask of the identical transcript, while the
step number and the block index do not move. They are identifiers rather than
ledger keys. A
fan-out writes three rows to `course.model_calls`, one per city on the scout
seat, and exactly one row to `course.tool_calls`, the parent
`research_destination` call's, because `ledgerRunner` wraps the whole fan-out
from outside and stays that table's only writer. Three writers on
`(turn_id, call_id)` is the arrangement where the second reads the first's
insert back as `pending`, reports an ambiguous call, and ends a turn that was
fine, and a scout has no external side effect a ledger row would help anyone
replay. The ids ride on each returned brief, so a log line and the driver's own
result can both say which city answered.

A scout seat is the first Haiku seat to reach `buildRequest`, and it found a
request the assembler had been sending since lesson 5.1: `thinking: {type:
'adaptive'}`, which Haiku 4.5 refuses with `400 adaptive thinking is not
supported on this model`. Adaptive thinking now rides with the effort setting,
so a seat that takes no effort is sent neither, and `test/request-shape.test.ts`
pins both halves. The front desk (lesson 5.3) runs on a Haiku seat through the
same assembler, so that path was answering 400 on every live FAQ turn until
this lesson; no test caught it because every test in the suite replays a fixture
or a fake and the fixture matcher compares the model string and nothing else.

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
schema. "The old check" is three functions from two places, and the test says so:
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

From lesson 5.2 the tool registry is inside the harness. Every tool declares the
door it stands behind, `code` for our own gates and notebook and cashier, `api`
for a supplier we paid to answer, and the door is what decides whether a result
is fenced on its way into the model's context. `doorRunner` sits outside every
other wrapper, so a tool the desk does not hold and a call whose input does not
parse are refused before `course.tool_calls` records that anything started, and
the model gets a sentence it can correct itself from rather than an unknown-tool
string out of the supplier layer. On the way back a result is trimmed and then
fenced, in that order, because fencing first would cut the closing delimiter off
a long result and hand the model an unterminated fence.

The notebook is stored. `course.conversations.requirements` holds every field
she stated with its provenance, `loadNotebook` reads it at the top of every
driver step, and it rides to the model as the request's suffix rather than
inside the system prompt, because it changes the moment she states a fact and
anything cached behind it would be thrown away. Two things follow. The budget
gate judges a budget, on both paths a reader can run, instead of recording
`budget: not evaluated` with a reason. And provenance has a caller: the harness
decides whose word a patch is by asking whether this turn's transcript already
holds a `tool_result`, so a patch she typed is hers and a patch the model
composed after reading a supplier price is inferred, and an inferred patch may
tighten a constraint and never relax one, and may not touch a field she stated
herself at all.

The dates gate reaches a verdict too, and the window it uses is a stopgap this
lesson names as one. It runs from the first of the month she gave to the last
day of that month plus her nights, which catches a trip proposed in March and
does not catch a departure in the half of the month she did not want. The honest
window needs `departureDate` and `returnDate` on the notebook, which means
changing `RequirementsSchema` and the extraction prompt, which changes what the
recorded `extract-portugal` fixture would return, and no test run has a key to
record a new one. Module 6 records fresh fixtures and is where the notebook
grows dates.

What is still owed here. `trimForContext` cuts on size and not on price age:
SPEC section 5's `pricePersistence` half would strip a price past its window and
tell the model to search again, and this branch judges a stale price at the
freshness gate instead, so adding it would be a second definition of stale over
a different input. The cost is that the model can quote her a price the gate
will refuse a step later. The planning desk now publishes `ask_user`, which the driver answers by ending
the turn on her question. Until lesson 5.3 `npm run trip` ran `turn()` and
`toolLoop`, which have no such step, so on that one path `ask_user` came back to
the model as an error result; that script runs the driver now and both paths
park the turn on her question.

From lesson 5.5 the fence carries a nonce. `<tool_result-<16 hex>` is minted per
call, after the result comes back, so the string that closes the wrapper did not
exist when the supplier wrote its payload. The escaping stays, because the two
together mean an attacker has to beat both, and anything nonce-shaped is
stripped out of the payload, which is the only way a nonce could be beaten
without knowing it, with one exception it names: a run of sixteen decimal digits
is a ticket number rather than a nonce and survives. The corpus in
`test/injection-corpus.test.ts` runs the closing tag exactly, in mixed case, with
whitespace inside the tag, with a newline inside the tag, nested, doubled,
through the interpolated tool name, through a supplier's source id and through
the notebook, and every case is a payload a real supplier could return. The
source id is covered twice: as pure calls in that file, which need no database,
and against a real `rehydrateRefs` violation in `test/gate-rehydrate.test.ts`,
which does.

Two residuals are accepted here on purpose and are written down as decisions
rather than left as oversights. A payload containing Unicode homoglyphs of the
delimiter passes through, because it is not the delimiter and closes nothing; it
reads like a closing tag to a person looking at a transcript, which is a fact
about people rather than about the model. And an already-escaped payload arrives
with `&lt;/tool_result&gt;` visible in it, because a supplier that escapes its
own output is indistinguishable from an attacker who escaped theirs, and
unescaping to make the text read better would create the hole.

The agency has two exits and this lesson closed both. `sanitizeOutbound` runs on
every agent message `src/worker.ts` writes that anything outside this repository
could have shaped, and there are two: the model's own reply, in the `message`
branch before `completeTurn`, and the hand-off sentence `completeIfLinkEmitted`
rebuilds from `course.link_clicks` after a link went out. The only other writer
of a message is `failTurn`, and every sentence that reaches it is built here out
of our own strings rather than composed by a model. The check sits in the worker
rather than inside the driver, so an agent a later module writes gets it without
asking.

It strips any URL that is not one the cashier itself built, an image above all,
because a markdown image is a request her browser makes with no tool call
anywhere in it and every allowlist this course has built watches tool calls. The
comparison is against the cashier's link PREFIXES and not against its hosts,
which is a distinction one host makes expensive: `www.google.com` is a booking
host, because a searchapi hotel is booked on a Google entity page, and a host
comparison also said yes to an image endpoint and an open redirect on the same
domain, which are an exfiltration path and a way to land her on the attacker.

And it removes a request that asks HER for a card, a document, a code or a
payment, which is a blocklist and is the right shape only because the agency has
no legitimate use for making one: it never takes a payment, never holds a
document and never verifies an identity. It matches the request and not the
noun, because "the hotel asks for a 100 EUR deposit to hold the room" is a
cancellation policy the planning desk is told to relay, and the seven ordinary
travel sentences that a noun-matching version fired on are negative cases in
`test/outbound.test.ts` now. A hit takes out the span that fired and leaves the
rest of the message standing, so an itinerary whose last line asks for a card
still reaches her as an itinerary.

The browser's half is owed and is not here. A Content Security Policy with
`img-src 'self'` would stop a remote image at the renderer even if the check
above missed one, and a persistent line under the composer saying the agency
never asks for payment is what makes the rule legible to her rather than only to
us. `public/index.html` is a placeholder and there is no renderer in this
repository, so both are named rather than built, and lesson 5.7's proposal card
is built as a pure function for the same reason.

Taint and fencing are separate properties and this lesson is where that becomes
load bearing. `propose_itinerary` stands behind a `code` door and is not fenced,
and its rejection sentence contains a supplier-derived total, which is precisely
the sentence that would motivate raising a budget to fit. Provenance is derived
from whether the transcript holds a `tool_result` at all, with no regard to the
door, so the notebook write after that rejection is stamped `inferred` and the
money gate holds.

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
contradicting them reads that table first, through one function.

That function is `completeIfLinkEmitted` in `src/worker.ts`. It reads the table
and, if anything went out, ends the turn `done` carrying the sentence the
hand-off said. `runTurn`'s catch calls it directly, because it has an error to
re-throw afterwards and never wanted `failTurn` at all. Five failing exits call
it through a second helper, `failTurnUnlessLinkEmitted`, which is that function
plus the `failTurn` to fall back to when nothing went out: `loop`'s four, the
fail-closed spend read, `decideNext` saying stop, an ambiguous tool call and the
agent's own `fail` step, plus `continueLater`'s `MAX_ATTEMPTS` arm, which ends
the turn rather than handing it back and so is covered by the same rule. Six
ways for a turn to end badly, one read of the table, one description of what it
does.

The sweeper's crash arm calls the same function, with a closer of its own
(`completeReapedTurn`, `src/repo/turns.ts`), because a worker that died outright
never reached any of the six. It holds no claim and the turn it finds is as
often `queued` as `running`, which is the one clause that differs. So a
crash-looped turn that emitted is `done` with her links in front of her and its
conversation back on `awaiting_user`, not `failed` with `crash_loop`: that row
used to exist, and a reader partitioning `course.turns` by `fail_reason` would
have filed a turn that emitted two live booking links as a failure with no
links.

A second hand-off is refused by the cashier itself, before it re-quotes
anything, which is the other half of the rule.

On tier 3 the emission is also `beginToolCall`-protected, because `cashierRunner`
sits inside `ledgerRunner` there. `npm run trip` is ledgerless by design, so it
is not: one process, no crash to resume from, and nothing to replay. The comment
above its chain says so.

From lesson 5.6 the agency remembers two kinds of thing, in two tables, for a
reason that is about who may be shown what rather than about tidiness.
`course.user_memory` holds facts about one traveller and carries her user id, so
a per-user row policy can be written against it, which is lesson 5.7's subject.
`course.source_memory` holds facts about a supplier or a property, which are
true for everybody and belong to nobody, so it carries no user id at all. One
table holding both would make that policy impossible: scoping it by user would
hide every source fact from everybody, and not scoping it would show one
traveller's facts to another.

Memory is fenced on the way into the prompt, with the same wrapper and the same
per-render nonce a tool result gets. At least one writer of that table is a
model that had just finished reading a supplier's page, so an unmarked memory is
a laundering channel: a fact recorded as "this property asks guests to confirm a
card number by email" is a true thing to remember and an instruction if it
arrives unlabelled.

The four cache breakpoints are placed where the prefix that repeats actually is.
One goes on the system prompt and the tool schemas at a one hour TTL, because a
resumed turn is always past five minutes and that is when a warm cache is worth
the most, and three go on the transcript, one rolling on its last block and two
spaced inside the twenty block lookback. A thinking block cannot carry a
breakpoint, so the walk skips to the next eligible block rather than
special-casing it, and the rolling breakpoint is found by searching backwards
rather than by reading the end, because a transcript that ends on an empty
content array would otherwise index at minus one. Memory and the notebook sit
after the last breakpoint, so a fact she states invalidates nothing.

`costMicros` takes the cache TTL as a required third argument now, and it has no
default. A one hour cache write bills at twice base input where a five minute
write bills at 1.25 times, so a `'5m'` default would under-bill every long write
by sixty percent, with no error, no failing test and nothing to distinguish the
result from a legitimately small number. `estimateMicros`'s bound moved in the
same commit, from 1.25 times list to twice list, because a bound that can
undercount is not a bound, and the reciprocal test in `test/memory.test.ts`
prices an all-cache-write usage against it so the multiplier is more than a
comment.

Drift is detected behaviourally and not by reading the response. `response.model`
echoes the alias we sent and `claude-opus-5` is alias only, so a string
comparison cannot see a weights change. The canary in `test/canary.live.test.ts`
sends a golden prompt at the seat's exact configuration and is pinned against
`modelConfigId`, which encodes model, effort and ceiling, so a failure names the
configuration that produced it. It is gated on `LIVE_MODEL=1` and reports
SKIPPED rather than passed when the gate is unset, so a keyless suite run cannot
be mistaken for a run that checked the live path.

## Residuals

Everything this branch knows about and did not close, each with an owner. What
module 5 built and what it left is first, added at lesson 5.7; module 4's own
list follows it, unchanged except where lesson 5.7 closed an entry or changed
what was true about one, because eight of those entries are module 4's record of
itself and deleting them to make room would erase a history rather than close
it. An owner is a lesson, a module, or a person, and "a person" means there is
nothing to design: somebody has to type it.

From lesson 5.7 the channel splits, and what it splits on is who wrote the
sentence. The MODEL's prose reaches her with every currency-shaped token
replaced by `[amount]`, because the model has read supplier payloads and an
amount in its own words may be an invention. What `redactCurrency` removes is
exactly that text and nothing else. Prices reach her from the SERVER in two
shapes. One is the card, rendered from what the gates rehydrated out of
`course.tool_results`. The other is the booking hand-off sentence, which
`completeIfLinkEmitted` (src/worker.ts) builds from `course.link_clicks` rows
and writes to `course.messages` through `sanitizeOutbound` and, by design, not
through `redactCurrency`: those figures were re-quoted server side at the moment
the links were minted, which is the same guarantee the card makes, and the
sentence is the agency's own prose around the agency's own links rather than
anything a supplier or the model supplied.
The redactor is a pure function over one streamed chunk with no state between
calls, so it over-redacts at a chunk boundary rather than buffering, and a
stutter-free stream that costs her a stray digit is the better trade. It does
not try to tell a real price from an invented one, because it cannot: every
amount goes, and the card underneath carries the ones the server can stand
behind.

The card is a structure and not markup, and `renderProposalCard` refuses a
rejected proposal outright rather than rendering one with a caveat on it. Every
component carries its own change action, mapping to `revise_component`, so
changing one night does not mean restating the whole trip, and every card
carries the line saying the agency never asks for a payment, a card number or a
document in a message. That line is on the card rather than only in the desk
prompt because a prompt is an instruction to a model and this is a promise to
her, and the two fail differently. A source id on a card goes through
`sanitizeSourceId` and a supplier's NAME does not: that function has been an
allowlist of `[A-Za-z0-9_-]` since lesson 5.5's fix round, which is right for an
id and would render "Beachfront apartment, Faro, 7 nights" as one unreadable
word, so a name loses its control characters and its length past a cap and keeps
everything she has to be able to read.

Nothing in production wrote `proposals.decision` from lesson 4.6 until now.
`decideProposal` was written and tested and its caller was a person's click on a
card that did not exist. The card exists, its accept action calls it, and
`npm run trip` reaches a real booking link through a real decision rather than
through a script answering for her.

A request that needs a person ends the turn `done` and the conversation
`escalated`, with no fail reason, because nothing failed: the turn ran, it
decided the agency could not do this, and it said so. `escalated` needed no
migration, and that is worth saying plainly because the plan for this lesson
expected one: `conversations_status_check` has accepted the value since 0004.
What was missing was a writer and a sentence, so `escalationRunner` records the
event and `statusInWords` turns any of the seven statuses into something she can
act on. `FAIL_REASONS` and `turns_fail_reason_check` did not move in this module,
and two tests say so.

`course_worker` exists, with a policy on each of the eight tables that carry a
traveller's own rows and a grant to that role by name. Four tables are granted
nothing at all: `course.model_calls`, `course.daily_usage`, `course.tool_calls`
and `course.gate_results`, which the owner connection writes instead. The grant
is by name rather than `on all tables in schema course` because a table with a
grant and no policy is a table every worker session reads in full, which is the
opposite of what a migration that then enables RLS on eight tables reads as
doing; `test/isolation.test.ts` has a case per ungranted table that goes red the
moment the grant widens, and a pair of cases that run one unscoped query as the
owner and as the worker, because either half alone proves nothing.

What actually RUNS under that role today is one read: the per-step notebook read
in `netlify/functions/run-turn-background.mts`, through `withUser`. That is less
than the role is built for and the reason is `withUser` itself, which is one
transaction. A turn on tier 3 is up to fourteen minutes of work whose heartbeat
has to be visible to the sweeper while it runs, and whose `course.link_clicks`
rows have to be committed before the model is handed the URLs built from them,
so a turn wrapped in one transaction would break the crash recovery this whole
branch is built on. Putting the rest of a turn's own rows under the role means
giving the harness a unit of work smaller than a turn. Owner: module 6, together
with the two tables the runner chain writes that have no policy at all, where a
forgotten `and user_id =` inside `ledgerRunner` or the gate pipeline is still a
forgotten clause; both are keyed on a turn id the worker already proved it owns,
which bounds it.

`course.daily_usage` and `course.model_calls` carry no policy on purpose, and
that is the important half: the global daily ceiling sums `cost_micros` across
all users on every check, and under a per-user policy that sum would silently
return only the caller's own rows, so the one ceiling that stops the whole
system spending unbounded money in a day would stop firing with no error and no
failing test. RLS is enabled and not forced, so the owner still bypasses it,
which is what makes that possible and what makes `npm run migrate` work; the
isolation this buys is against a query we forgot to scope and not against
somebody holding the owner's connection string.

The capture columns on `course.model_calls` are written by the driver and by
nothing else. `redactCredentials` runs inside `pgSink` rather than at the call
sites, so a caller cannot skip it, and it runs BEFORE serialisation with the
result parsed back to an object, because `sql.json(<a string>)` stores a jsonb
string scalar on which `response->>'stop_reason'` is null forever. The routing
call fills the half of the capture it honestly can, which is the text the
decision was made from: `classifyDesk` returns a `Routing`, so its own system
prompt, the response body and the request id never leave that function.

No cheap-seat call is captured at all today, which makes one branch of
`capturePolicyFor` dead code in production. Its only caller is the driver, which
passes `driver` or `front_desk` every time, and both return `full`, so
`'truncated'` is never returned, `clip` never clips and `MAX_STORED` bounds
nothing. `runScouts` calls `pgSink` with no capture fields, so a scout row's
`capture_policy`, `system_prompt`, `user_prompt` and `response` are null rather
than truncated, and the three model calls a fan-out makes are the highest-volume
calls on the branch with the least recorded about them. The rule is written and
tested and waiting for a caller. Owner: module 6, whose evals are the first
reader with a reason to want a scout's prompt back.

The monitor alarms into a log, because this repository has nowhere to page. It
runs after the turn is closed, it can fail no turn, and its own model call is not
metered against her ceilings, because it is ours rather than hers. It writes no
`course.model_calls` row either, and that is the larger half: `src/monitor.ts`
calls the model and calls no sink at all, so the charge is invisible to
`turnSpendMicros`, to `group by seat`, to the drift canary and to every ceiling.
It runs once per completing turn, so it is a real recurring cost with no record
anywhere, which is the exact condition `src/repo/spend.ts` calls worse than a
row that might be refused a moment later. What it can see is bounded by what it
reads, which is `course.agent_events` and `course.model_calls`: the shape of a
turn that finished, and not a turn that was killed, and not money that `reserve`
debited and no `reconcile` gave back. Owner of all four: module 6, where a
`seat: 'monitor'` observability row through `pgSink` would make the spend
countable without putting it on her ceilings, and where changing what
`turnSpendMicros` returns belongs beside the evals that read it.

What is owed, and where it lives. The browser's half of SPEC section 10 is not
here, because there is no browser, and `public/index.html` is still a
placeholder. Nothing streams either: `callModel` sends a non-streaming request
and tier 3 writes one message at the end of a turn, so `redactCurrency` runs
over a whole message. It is written as a pure function of one chunk with no
state between calls anyway, and the chunk-boundary case is tested, because that
is the property a redactor cannot be given later: a stateful one that buffers
until it has seen enough is a stream that stutters, and swapping it out once
prose is arriving live is a change nobody makes calmly. And `src/conversation.ts`'s
`turn()` is still the one-process path modules 1 and 2 built, still replayed by
`test/conversation.test.ts` and four recorded fixtures, and no longer the
production one; module 6 retires it, because its evals drive the driver.

The browser's half of the outbound check does not exist. `sanitizeOutbound`
(src/sanitize.ts, lesson 5.5) strips a remote image and a remote link from every
agent message before it is written, and a Content Security Policy with
`img-src 'self'` would stop one at the renderer even if the check missed it,
which is the defence that does not depend on a regular expression. The
persistent line under the composer saying the agency never asks for a payment is
the other half, and it is what makes the solicitation rule legible to her rather
than only to us. `public/index.html` is a placeholder and this repository has no
renderer, so neither can be built here. Owner: whoever builds the renderer.

The outbound URL check admits a link the cashier COULD have built and not only
one it did. It compares the prefix of each of the cashier's templates, so a model
an untrusted listing has talked into it can still write
`https://www.google.com/travel/hotels/entity/x?ap=<her notebook>`, or the same
tail on the kiwi and mock prefixes. That is a privacy leak to a counterparty this
agency already transacts with rather than an attacker channel: there is no
attacker-controlled host and no redirect under any of the prefixes, so the data
lands in a supplier's own request log rather than on a server somebody hostile
reads, which is categorically different from the "an image pointing anywhere,
with no tool call in it" path lesson 5.5 closes. The complete answer is equality
against the links actually emitted for the turn, which changes
`sanitizeOutbound`'s signature and has nothing to compare against on the
`ask_user` path, since that path emits no links. It is a design change rather
than an edit, which is why it is owned rather than fixed. Owner: module 6.

Unicode homoglyphs of the fence delimiter, and an already-escaped payload, both
pass through `escapeFence` unchanged. Neither is a breakout: a homoglyph is not
the delimiter and closes nothing, and an already-escaped payload cannot close
anything either, while unescaping it to make a transcript read better is exactly
how the hole would be created. Both are accepted deliberately and are recorded
in `fenceResult`'s own docstring as decisions. Owner: nobody.

CLOSED at lesson 5.7: nothing in production set `decision`. `decideProposal` was
written and tested, and its production caller was the accept button on a
proposal card that did not exist. `acceptCard` (src/channel.ts) is that button's
one server-side path now, `npm run trip` prints the card and takes it, and
`npm run demo`'s sixth scenario answers through it rather than in process.

Open at lesson 5.7, and reachable from lesson 5.7: the two paths that REQUEUE a
turn rather than end it still do not read `course.link_clicks`. They are
`continueLater`'s hand-back in `src/worker.ts` and the sweeper's requeue arm,
and they are the unenforced half of module 4's headline invariant. What changed
here is not the code on those paths, which is untouched, but the world around
them: 4.6 could say the second set of links for one trip was unreachable because
nothing in production wrote `proposals.decision`, and the accept action on the
card writes it now. Neither path can emit the same link twice, because the
cashier refuses a second hand-off of a proposal that already emitted and
`unique (proposal_id, item_id)` stands behind that; a requeued turn that proposes
again gets a NEW proposal id, which that constraint does not cover. Closing it
means deciding what a requeue owes a turn that has already handed off, which is a
harness question rather than a channel one. Owner: module 6, which also owns the
one turn the sweeper's crash arm can leave alive-looking, for the same reason 4.6
handed these two over together.

The sweeper's crash arm can leave exactly one turn alive-looking: one that
handed off twice in two currencies, which `handOffMessage` cannot total
(`sumMoney` refuses to combine two codes). There is no sentence to write, so the
failure is logged and the row is left for the next walk rather than marked
failed, which rule 6 forbids. The cashier refuses a second hand-off today, so
nothing in production can build such a turn. Owner: module 6, alongside the
requeue paths, which is where lesson 5.7 moved both.

The affiliate id in every link is a placeholder, not an account. Owner: a
person, with a supplier contract in hand.

`classifyDesk` (src/classify.ts) takes no `AbortSignal`. `callAndRecord`'s meta
accepts one (src/metered.ts) and the routing call passes none, so it is the one
model call on the deployed path a fence cannot cancel: a turn another worker has
claimed keeps that call in flight and still writes its reconcile, its row and its
desk against a conversation somebody else is now driving. The exposure is a
one-line Haiku prompt, which is why it is named rather than fixed under a frozen
tag. Lesson 5.6 threaded a new required argument through `src/classify.ts`,
`src/metered.ts` and every other call site of `costMicros` and did not add the
signal with it, so the exposure is unchanged and only its owner has moved.
Lesson 5.7 did not close it either, and it now has a second reason to be closed
in one go: `classifyDesk` returns a `Routing`, so the routing call's row carries
the text the decision was made from and no response body and no request id, and
both the signal and the capture want the same change, which is that function
handing back a `ModelResult`. Owner: module 6.

`turns.spend_usd_micros` can over-report the routing call, in two ways, and
neither touches a ceiling. A step-0 retry that finds the decision
`selectDesk` already took returns that decision's cost again, and the first
attempt had already added it to the column. And on a front-desk turn the ANSWER
call is recorded on the same `front_desk` seat as the routing call, so if the
routing call's best-effort `pgSink` row is the one that was lost,
`readDeskDecision`'s `order by seq limit 1` returns the answer call's cost as
the routing cost. Both add micros the ceilings never saw, because a driver step
carries `alreadyRecorded: true` and `recordSpend` is never reached, so the
conversation and daily counters hold exactly what `reconcile` settled. Telling a
routing row from an answer row needs a column `course.model_calls` does not
have, which is why this is owned rather than patched. Owner: module 6.

`course.conversations.requirements` has one writer, `applyRequirementsPatch`,
and one tool behind it. Both paths now read it once per agent step, which is the
step that then proposes, because lesson 5.3 put `npm run trip` on the same
driver tier 3 runs. What is left is narrower: a patch and a proposal inside the
SAME step are judged against the notebook as it was when that step began, since
the constraints are built before the model is called. Owner: whichever lesson
first needs a tool to write the notebook and propose in one step.

`course.link_clicks.user_id` carries no constraint of its own. `proposal_id` has
a single-column foreign key to `course.proposals(id)`, and nothing in the schema
ties a link row's user to its proposal's user, because `course.proposals` has
`unique (id, conversation_id)` and no `unique (id, user_id)`, so the composite
key every other child table here carries is not available. The one writer
compares them in code and refuses a mismatch (`src/cashier.ts`). Lesson 5.7 was
expected to add a second writer and did not: `acceptCard` is a second CALLER of
`handOffToBooking`, which is still the only thing that writes this table, so the
in-code comparison still covers every row. Owner: module 6, in the migration
that next touches this table; 0013 is frozen, and the fix needs
`unique (id, user_id)` on `course.proposals` first.

`gate_results.proposal_id` is always null and `round` is always zero. `runGates`
accepts both and no caller in `src`, `scripts` or `netlify` supplies either,
because `proposalRunner` records the proposal AFTER the gates return. So
`gate_results_by_proposal` indexes a column nothing writes, and 0012's own
column comment, which says a non-first round carries a proposal id, describes a
run this branch cannot produce. Owner: module 5, when a rejected proposal is
re-run and rounds start to mean something.

`recordResults` assigns `seq` from a `jsonb_to_recordset` scan with no `order
by`, so it relies on Postgres emitting a single array's elements in array order.
It does, and there is no plan shape here that would reorder it, and
`test/toolResults.test.ts` asserts which of two rows sharing a `fetched_at` wins
rehydration, which is only true if that holds. The assumption is written into
the statement's own comment in the round that wrote this list, so it is here for
the record rather than as work. Untested still, and untestable without a plan
this schema cannot produce. Owner: nobody.

`test/helpers/provenance.ts` said its guard covered "any file" naming
`offeredAmounts`. It enumerates `testFiles()` only, so a `src/` file naming it
would pass. Corrected in the same round that wrote this list, so it is here for
the record rather than as work: the guard is still test files only, and the
docstring now says so. Owner: nobody.

`LESSONS.md`'s "How this branch was built" heading counted module 3's seven
lessons and then grew module 4's bullets underneath it. Corrected in the same
round that wrote this list, so it is here for the record rather than as work.
Owner: nobody.

`src/cashier.ts` described lesson 4.6 in the future tense, four hundred lines
above the code that lesson landed. Corrected in the same round that wrote this
list, so it is here for the record rather than as work. Owner: nobody.

A scout fan-out killed between its `reserve` and its last `reconcile` strands up
to the whole batch reservation, `n` times the per-call bound, on
`course.conversations.spend_usd_micros` and on `course.daily_usage.cost_micros`.
A kill during the searches is the one window this does not cover, because an
abort there refunds the whole batch before it re-throws.
Nothing sweeps a reservation: `failTurn`, `releaseForContinuation` and the
sweeper all move turn state and not spend. It is the driver's own exposure
multiplied by `n`, and a fan-out is the longest single wait in a step, so tier
3's fifteen-minute kill is a realistic trigger for this path in particular. A
`reconcile` that fails after a billed call strands one scout's share the same
way; that one is caught rather than propagated, so the brief, its
`course.model_calls` row and the real cost on the result all survive, and
`src/agents/scout.ts` says what each failure leaves behind. Losing a refund
fails closed, which is why neither is treated as an emergency. Closing either
needs a reservation something can sweep, which means rows rather than two
counters. Lesson 5.7 does NOT make this visible, and the earlier version of this
paragraph said it did, which was the sort of claim the review is for. The monitor
is the only new thing that could have: it reads `course.agent_events` and
`course.model_calls`, and `reserve` and `reconcile` write neither, so a stranded
reservation is not in a turn's shape. It is also invoked after `runTurn` returns,
and the case here is a turn killed before it can return. Both halves would have
to change, and the first one needs a row per reservation that nothing writes, so
a stranded reservation stays invisible until something sweeps one. Owner:
module 6.

A `research_destination` row already in `course.tool_calls` is priced at three
supplier searches whatever it really asked for, because migration 0006 stores no
input and nothing else in the row can say. A turn that fans out to one city is
therefore charged for three, which can refuse a later search that would have
fitted. It fails in the safe direction and the alternative is a migration, so it
is accepted rather than closed. Lesson 5.7 did not close it: the one migration
that lesson is allowed went on the capture columns, the feed and the role, and
adding a column to `course.tool_calls` to price a row correctly is a change to
the ledger rather than to the channel. Owner: module 6.

A resumed turn is charged twice for a `research_destination` it already ran, and
can be refused a fan-out the ledger would have replayed for free.
`assertSupplierBudget` runs in the driver BEFORE `deps.run`, and
`countSupplierCalls` (src/tools/supplierBudget.ts) counts the row `ledgerRunner`
already wrote for this same `(turn_id, call_id)`, so the resumed attempt prices
its own replay on top of the original. Worked case: a `search_hotels` costs one
and a three-city fan-out costs three, which puts `used` at four, and the resume
computes four plus three against a cap of six and refuses a replay that would
have reached no supplier at all. It fails closed and costs her turn work rather
than money, and the fix is for the driver to ask whether a `done` row already
exists for this call id before it prices the budget. Owner: module 6.

Closed at lesson 6.2: migration 0012's header cites a spec section and this
lesson by number, a document outside this repository, and the migration is
frozen. What it meant is this lesson: a table that recorded only failures could
not answer how often freshness fired, and `gateMetrics`
(src/evals/gateMetrics.ts) is the reader that asks. The citation stays in the
file, byte for byte, and the answer is here rather than in a new migration.

Open at lesson 6.2: all four of `gradeOutput`'s and `gradeTrajectory`'s deferred
checks still print as `passed: null` when you run `npm run evals`, and for two
different reasons. `every_number_has_a_search` and `questions_before_guesses`
read a transcript this runner does not assemble yet, and lesson 6.5 assembles
it. `within_budget` and `inside_her_window` are a different case: the machinery
is here, `replayGates` (src/evals/replay.ts) re-runs the gates over a stored
proposal and `gradeOutput` takes its recorded per-gate verdicts as a fourth
argument, so both checks CAN reach a verdict. Nothing hands one in yet. Nothing
outside `test/eval-replay.test.ts` calls `replayGates`, because the runner
grades two mock worlds rather than driving a conversation, and a world that
never proposed anything has no proposal to replay. Lesson 6.3 drives the
conversation that reaches one, and until then the two checks print not evaluated
with the reason. It closes `within_budget` and not `inside_her_window`, for a
reason that belongs to the notebook rather than to the replay, and the lesson 6.3
entry below says which. The runner exits 1 when a check is false and 0 when the only
unfinished business is a null, so the proof command can go red on a real verdict
without the unbuilt checks reddening it every time somebody runs it.

Open at lesson 6.3: three golden cases ship, and P3 describes twenty
adversarially chosen ones. The missing seventeen are named in the lesson (the
discovery conversation, the unstated budget, the gibberish opener, the request
in Portuguese, and the rest) and each costs one recorded fixture to add, which
is the whole of why three shipped. Owner: a person, growing the file one case at
a time with the recording that makes it replayable.

Also open at lesson 6.3, and found by the eval rather than by reading the code:
the planning desk asks too much and writes the notebook too often. Every one of
the three cases fails both trajectory checks. `call_count_fits_the_job` reads 68,
60 and 80 tool calls against ceilings of 10, 4 and 8, and `questions_stayed_few`
reads 7, 11 and 10 questions against ceilings of 3, 2 and 3.
`update_requirements` is 43 of the 68 (63%) and 41 of the 60 (68%), a majority in
both, and 24 of the 80 (30%) in the refusal case, where it is beaten by 28 hotel
searches. The red rows are the eval working rather than thresholds set too
tight, and closing them is a change to the desk prompt and to what the tool
result says back, which is a lesson of its own. Owner: module 6, once the judge
in 6.6 can say whether a shorter path answered her as well.

Open at lesson 6.3, and carried over from 6.2: `inside_her_window` is a verdict
on no case at all. The card reads `0/0 (n/a, 3 not evaluated)`, and the reason on
each row is the dates gate's own: `travelWindowFrom`
(src/gates/notebookConstraints.ts) resolves a window only from a bare month name,
every persona says "September 2026" or "October 2026", and the desk records the
month in her words, so the gate reaches no verdict and the graded check follows
it honestly rather than inventing one. `within_budget` IS closed at this tag, at
2/2 over the two cases that proposed. Owner: lesson 6.4, which takes `today` and
the case's dates. Making her say "October" would close it and would also change
what the dates gate decides on two cases that currently propose, which is why it
is not a one-word fix.

A local Postgres is worth setting up before you run these. `test/eval-run.test.ts`
drives three whole conversations one database round trip at a time, and against a
remote database that is minutes rather than seconds. Nothing in it waits on a
model: every response is replayed off a recording.

What the first run of these cases found and this lesson DID close: the desk
could not record a single fact. `update_requirements` publishes `patch` as a
free record, nothing told the model the eight names the notebook accepts, and
`applyRequirements` refuses a patch WHOLE when one key is unknown (src/notebook.ts),
so every patch the desk composed was discarded and every turn after the first
one started with an empty notebook and no memory. One paragraph in
`src/desks/planning-desk.md` names the fields and their shapes, and the three
recordings were made against it. Nothing but a multi-turn conversation could
have found this, because a single-turn trip never reads the notebook back.

Open at lesson 6.4: pass^k measures the model only when the model is the thing
that moves, and on a replayed run the model does not move at all, so the number
this suite prints keyless is a check on the harness rather than a measurement of
the desk. `npm run evals -- --runs 3` prints three runs of each case that agree
to the tool call, which is the harness reporting that every input is pinned. The
measurement needs `LIVE_MODEL=1` and a key and costs real money, which is why
the flag defaults to one run. Owner: whoever runs the nightly schedule lesson
6.6 writes down.

Also open at lesson 6.4, and the largest bill module 6 carries: the three
recordings were made before the supplier world was pinned, so they replay in
MockConfig's default world and not in the world `seedFor` gives their case. The
model's own `propose_trip` names the source ids it saw when the recording was
made, and replaying those responses anywhere else fails the provenance gate on
every proposal, correctly. `evals/run.ts` passes `RECORDED_WORLD_SEED` for that
reason and `seedFor` is what a case gets the first time it is recorded in a
world of its own. Until then a live run and a replayed run of one case are two
different worlds. Owner: a person with a key, re-recording the three.

Open at lesson 6.4, operability: `npm run evals` writes to the reader's real
database and cleans up nothing, so `--runs 3` leaves nine conversations and their
turns, messages, corpus rows, gate results and daily_usage rows instead of three.
The money is simulated and the ledger is not, because a replayed call is priced
from the usage in its recording and debited like a real one, so a pass is worth
more than $2.50 of the $50 cross-user day that `npm run trip` shares. Owner:
lesson 6.6, where the nightly schedule makes it sixty conversations a night.

The three `pass^k:` rows read 0/3 at this tag, and not because anything is
flaky: `call_count_fits_the_job` fails on all three cases for the reason the
lesson 6.3 residual above gives, and a case with a failed check did not pass.
Consistently failing and flaky are different words on this card on purpose.

Closed at lesson 6.5: `gradeTrajectory` files no check as `passed: null` any
more. Every property the scorecard names now reaches a verdict, or says in its
own detail line why it could not look, which is a different sentence. That
closes the first half of the lesson 6.2 entry above, and it moves two numbers
that entry and the lesson 6.3 one printed. `loadTrace` (src/evals/trajectory.ts)
reads the calls off `course.model_calls.response` rather than off the persisted
transcript, because a valid `ask_user` ends the turn before the transcript is
appended to and is therefore in no transcript anywhere, and it counts the FIRST
`tool_use` block of each reply, which is the one the driver answers. So
`call_count_fits_the_job` now reads 22, 50 and 68 executed calls against
ceilings of 10, 4 and 8, where the lesson 6.3 entry above recorded 21, 40 and 52
read a different way, and the three recordings carry 59, 107 and 140 blocks the
model emitted behind those. `questions_stayed_few` counts QUESTIONS rather than
`ask_user` calls, at 3, 32 and 61 behind 1, 11 and 20 calls, so
`portugal-toddler-01` passes it and the other two are red at three times what
the old count showed.

Open at lesson 6.5, and found by running the card rather than by reading the
code: `every_number_has_a_search` reports `0/0` on all three cases, because
there is not one amount in any reply for it to look at. `redactCurrency`
(src/channel.ts, lesson 5.7) replaces every currency-shaped token in the model's
prose before it reaches `course.messages`, so the only amounts that ever reach
her thread in figures are the card's, which is a structure and not prose, and
the booking hand-off sentence `completeIfLinkEmitted` builds from
`course.link_clicks`. None of the three golden cases books anything, so none of
them puts a number where this check can see it. The check is right to say it
could not look, and what it is waiting for is a case that reaches a booking
link. Owner: a person, with the recording that case needs.

Also open at lesson 6.5: `announcedButNeverCalled` matches one class of claim,
the entry-requirements one. The class is larger than that regex: "I compared
three neighbourhoods for you" is the same fault about a different subject, and a
pattern per claim does not scale. The honest next step is deriving the claim from
the tools the desk published rather than from a list of sentences. Owner: a
person, or module 7 if its examples work wants the same derivation.

Also open at lesson 6.5: the trace depends on a capture policy. `loadTrace` can
only read a model call the ledger captured, and `capturePolicyFor`
(src/repo/model-calls.ts) holds the driver seat at `full` today, so it reads
everything. A sampler on that seat, which that function's own comment says is
possible, would silently shorten every trace and every counter derived from one,
and nothing in this module would notice. What that needs is the per-call arity
recorded beside the spend rather than inferred from a captured body. Owner:
whoever adds the sampler.

`src/worker.ts` imports `labelTurn` from `src/evals/`, which is the harness
depending on a directory named for the suite that reads it. The dependency is
the right way round in substance, because the counters have to be extracted
where a turn ENDS and the eval only reads them back, and it is the wrong way
round in the file tree. Moving the counting into `src/repo/turnLabels.ts` and
leaving the grading in `src/evals/` is the shape that says so. Owner: module 7,
which is the first module that reads this table for anything.

## What is next

`LESSONS.md` lists every checkpoint tag next to the lesson it belongs to and the proof that lesson is done. Start there if you want to jump ahead or replay a specific lesson.
