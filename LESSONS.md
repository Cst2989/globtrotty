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
| lesson-3-1 | The claim with a fencing token | npm test (test/claim.test.ts) |
| lesson-3-2 | Heartbeats and leases | npm test (test/lease.test.ts) |
| lesson-3-3 | Completion in one transaction | npm run migrate, then npm test (test/completion.test.ts) |
| lesson-3-4 | The tool-call intent ledger | npm run migrate, then npm test (test/tool-calls.test.ts, test/crash.test.ts) |

Handoff to module 3: two presses of one key can straddle the moment a ceiling trips and leave a turn with no message. Since lesson 3.1's worker claims before it loads, that turn now reaches the sweeper as `running` with a fresh heartbeat rather than `queued`; the stalled-turn sweeper module 3 builds must reap it once that heartbeat goes stale, not by looking for a queued turn with no heartbeat.

A driver throw during a spend read escapes `turn()` today and strands the turn; since lesson 3.1 claims before running, that strand happens at `running` with a heartbeat already set, not at `queued`. Module 3's sweeper must reap it by that stale heartbeat or resume it, so a database outage ends as a denial she can see, not a turn that hangs forever.
