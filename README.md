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

## Running the agent live

If you want to talk to the real API instead of replayed fixtures, copy `.env.example` to `.env.local` and add your `ANTHROPIC_API_KEY`. Then run:

```bash
npm run trip
```

This calls the live API using whatever the travel agent can do at that point in the course.

## Holes the tests admit to

Most tests in this repo assert what already works. A few, marked `it.fails`,
assert what should work but does not yet: the body is written the way we
want the code to behave, and the test passes today only because that body
still throws. `test/crash.test.ts` is one: a turn that crashes mid-search
should let a retry pick up where it died instead of starting the notebook
over and calling the supplier again, and the assertion that checks the
supplier was called once is the one that fails. Vitest's `it.fails` lets
that gap live in the suite, visibly red under the hood, instead of as a
comment or a skipped test that quietly stops meaning anything. The next
module turns it into a plain `it`, and the suite tells us the moment it
does not yet deserve to.

## What is next

`LESSONS.md` lists every checkpoint tag next to the lesson it belongs to and the proof that lesson is done. Start there if you want to jump ahead or replay a specific lesson.
