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
late, and a driver that checks the signal (tier 3's does, between its own
model and tool calls) only stops at its NEXT call boundary, not mid-call. One
model or tool call already in flight when the fence lands still finishes and
is billed once. Threading the signal all the way through module 1's
`TurnOptions`, so a call already in flight could be cancelled outright, is
parked rather than done in module 3.

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

The supplier port is a port and there is still only one thing behind it. From
lesson 4.1 a `SupplierItem` says who quoted it, when, for how long it stays
quotable and whether it can be checked again, and `MockSupplier` answers all
four honestly for a supplier that invents its prices from a hash. Nothing yet
stores what a search returned, so the only thing that can read a price is the
model that was shown it, and the only thing that could check one is a caller
holding the same object. One seam is already open and the suite cannot see it:
every search now asks for `TRIP_CURRENCY`, so flights come back in euros, while
the recorded reply `test/provenance-v0.test.ts` replays still quotes them in
dollars, and that test's `offeredAmounts` compares whole-unit numbers without
ever looking at a currency. Lesson 4.4 is what breaks that test on purpose and
closes it. Lesson 4.3 is where a search becomes a row.

## What is next

`LESSONS.md` lists every checkpoint tag next to the lesson it belongs to and the proof that lesson is done. Start there if you want to jump ahead or replay a specific lesson.
