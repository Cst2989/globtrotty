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

"Went silent" is aspirational until the worker loop wires up a heartbeat timer.
Today the only thing that stamps a `running` turn's heartbeat is the claim
itself, so this arm's actual rule is a ceiling on how long a turn may run:
ninety seconds after the claim, it reaps a still-working worker exactly as
readily as a silent one. That worker keeps going and pays for what it does
after the requeue; the worker that claims the reissued turn pays again for the
same turn, so a long turn can be billed twice until the worker loop ticks a
heartbeat on a timer.

## What is next

`LESSONS.md` lists every checkpoint tag next to the lesson it belongs to and the proof that lesson is done. Start there if you want to jump ahead or replay a specific lesson.
