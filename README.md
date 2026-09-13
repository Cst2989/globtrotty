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

## Residuals

Everything module 4 knows about and did not close, each with an owner. The
first four are the module's own; the rest are what the whole-branch review found
across all six lessons and decided was worth naming rather than fixing under a
frozen tag. An owner is a lesson, a module, or a person, and "a person" means
there is nothing to design: somebody has to type it.

The browser's half of the outbound check does not exist. `sanitizeOutbound`
(src/sanitize.ts, lesson 5.5) strips a remote image and a remote link from every
agent message before it is written, and a Content Security Policy with
`img-src 'self'` would stop one at the renderer even if the check missed it,
which is the defence that does not depend on a regular expression. The
persistent line under the composer saying the agency never asks for a payment is
the other half, and it is what makes the solicitation rule legible to her rather
than only to us. `public/index.html` is a placeholder and this repository has no
renderer, so neither can be built here. Owner: whoever builds the renderer.

Unicode homoglyphs of the fence delimiter, and an already-escaped payload, both
pass through `escapeFence` unchanged. Neither is a breakout: a homoglyph is not
the delimiter and closes nothing, and an already-escaped payload cannot close
anything either, while unescaping it to make a transcript read better is exactly
how the hole would be created. Both are accepted deliberately and are recorded
in `fenceResult`'s own docstring as decisions. Owner: nobody.

Nothing in production sets `decision`. `decideProposal` is written and tested,
and its production caller is the accept button on a proposal card, which is
lesson 5.7: this module has no surface for a person's click. `npm run demo`'s
sixth scenario answers for her in process, so the keyless proof does reach a
real link, a real `course.link_clicks` row and a real hand-off message; what is
missing is her own click, not the path behind it. Owner: lesson 5.7.

The two paths that REQUEUE a turn rather than end it do not read the table:
`continueLater`'s hand-back in `src/worker.ts` and the sweeper's requeue arm.
Neither can emit the same link twice, because the cashier refuses a second
hand-off of a proposal that already emitted and `unique (proposal_id, item_id)`
stands behind that; a restarted turn that proposes again, though, gets a new
proposal id, which that constraint does not cover. Nothing in production writes
`proposals.decision` yet, so this is not reachable today, and it stops being
unreachable in the same commit that closes the residual above. Owner: lesson
5.7, both halves together.

The sweeper's crash arm can leave exactly one turn alive-looking: one that
handed off twice in two currencies, which `handOffMessage` cannot total
(`sumMoney` refuses to combine two codes). There is no sentence to write, so the
failure is logged and the row is left for the next walk rather than marked
failed, which rule 6 forbids. The cashier refuses a second hand-off today, so
nothing in production can build such a turn. Owner: module 5, alongside the
requeue paths.

The affiliate id in every link is a placeholder, not an account. Owner: a
person, with a supplier contract in hand.

`classifyDesk` (src/classify.ts) takes no `AbortSignal`. `callAndRecord`'s meta
accepts one (src/metered.ts) and the routing call passes none, so it is the one
model call on the deployed path a fence cannot cancel: a turn another worker has
claimed keeps that call in flight and still writes its reconcile, its row and its
desk against a conversation somebody else is now driving. The exposure is a
one-line Haiku prompt, which is why it is named rather than fixed under a frozen
tag. Owner: lesson 5.6, which already threads a new argument through
`src/classify.ts`, `src/metered.ts` and every other call site of `costMicros`.

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
compares them in code and refuses a mismatch (`src/cashier.ts`), and lesson 5.7
adds the second writer. Owner: module 5, in the migration that next touches this
table; 0013 is frozen.

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
counters. Owner: lesson 5.7, which builds the monitor that would see it.

A `research_destination` row already in `course.tool_calls` is priced at three
supplier searches whatever it really asked for, because migration 0006 stores no
input and nothing else in the row can say. A turn that fans out to one city is
therefore charged for three, which can refuse a later search that would have
fitted. It fails in the safe direction and the alternative is a migration, so it
is accepted rather than closed. Owner: lesson 5.7.

`supabase/migrations/0012_gate_results.sql` cites "spec §4.3, lesson 6.2". No
document outside this repository may be cited from code, and `git ls-tree` finds
no `docs` at any tag here, so a reader has nothing to open. The migration is
frozen and stays as it is; the reference belongs in the lesson prose. Owner:
module 6.

## What is next

`LESSONS.md` lists every checkpoint tag next to the lesson it belongs to and the proof that lesson is done. Start there if you want to jump ahead or replay a specific lesson.
