# Plan 3b — Gates Half — decisions taken during execution

Rulings made while executing `docs/superpowers/plans/2026-09-13-plan-3b-gates.md`, recorded
because they were taken on the author's behalf so the work could continue. Same format as
`2026-08-29-model-client-and-driver-decisions.md`: what was decided, why, and what it costs if
it was wrong.

Branch: `feat/plan-3b-gates` · 12 tasks, each reviewed individually — Task 4 took one fix round,
Task 6 took one fix round, Task 8 took one fix round — then a whole-branch final review that
returned four Important fixes and parked three residuals, addressed in one final fix wave (10/10
addressed, no new Critical/Important). **650 tests passing, 9 skipped** (live external-API
suites, gated) at merge.

---

## The four deviations from the plan header

### Deviation 1 — cashier atomicity is not one transaction across two systems

**Ruling: mint all `link_clicks` rows in one transaction inside the tool, and rely on the
worker's existing `pending` `tool_calls` row rather than a transaction spanning `finishToolCall`.**

The spec said "insert one `link_clicks` row per item … and `finishToolCall` with the links as the
result" in one transaction. `finishToolCall` belongs to the worker, not the tool — the tool has
no access to close out the row it did not open. A resumed turn that finds the row `pending` (mint
committed, `finishToolCall` never ran) reports `ambiguous`, which fails the turn `fenced` rather
than re-quoting. The links already committed are readable by `proposal_id` on the next turn.

**Cost if wrong:** a crash in that exact window — between the mint commit and `finishToolCall` —
fails the turn `fenced` instead of completing it; the money and the links are safe (already
committed, re-quotable by id), so the cost is one avoidable retry, not a lost booking. See "Task
12 finding" below for the parent-spec tension this creates.

### Deviation 2 — hotel URL allowlist is a shape check, not a fixed hostname list

**Ruling: SearchApi hotel URLs are checked for `https:` scheme, no userinfo, and a registrable
hostname (has a dot, not an IP, not `localhost`) rather than a fixed per-hostname allowlist.**

SearchApi's `link` is each property's own site — `test/fixtures/searchapi-hotels.json` carries
booking.com, bluepillow.com, and hotel-owned domains — so there is no fixed hostname to enumerate.
Kiwi keeps a real allowlist (`kiwi.com` and subdomains) because Kiwi's URLs are Kiwi's own.

**Cost if wrong:** a shape check is weaker than an allowlist; a supplier response carrying a
crafted `https://` URL on a plausible-looking registrable domain would pass where a fixed
allowlist would have caught it. Bounded by the fact that the hostname still has to look like a
real domain, and every URL is still built server-side from vetted fields.

### Deviation 3 — reviewer-at-ceiling skips the review rather than throwing

**Ruling: when `reserve` for the reviewer reports the ceiling reached, the reservation is
refunded, review is skipped, and the proposal saves `shipped_unapproved` with the issue
`reviewer skipped: spending limit reached`; the next driver step then fails the turn on the same
ceiling with her message.**

A throw from inside `run()` would fail the turn as `unclassified`, which is the wrong word for a
condition the harness already has a name for.

**Cost if wrong:** a mislabeled failure reason on an already-rare path (the spending ceiling); no
money or correctness impact.

### Deviation 4 — reviewer spend reaches `turns.spend_usd_micros` via an accumulator, not a second `recordSpend`

**Ruling: the `tool` step gains an optional `spent: { micros: bigint }` accumulator that the tool
increments; the worker adds it to the turn total after `run()` resolves, having already read
`recordedMicros` for the driver's own spend.**

The reviewer runs inside `run()`, after the worker has already read the driver's
`recordedMicros`. Without a second channel the reviewer's Opus call would either double-charge
(same bug class as the model-client-and-driver plan's B2) or vanish from `turns.spend_usd_micros`
entirely.

**Cost if wrong:** a double charge or an invisible spend on every reviewed proposal — the same
class of bug the previous plan's whole-branch review was built to catch, so a discriminating test
exists for it (Task 5's `expect(spent.micros).toBe(6_000n)`).

---

## Pre-flight ruling

### `saveProposal` serialises the notebook through `notebookToStored`, not `sql.json(notebook)`

**Ruling: export the notebook repo's existing `toStored` as `notebookToStored` from
`src/repo/notebook.ts` and use it in `saveProposal` for `requirements_snapshot`, rather than
`sql.json(args.notebook)` as the plan's Task 2 wrote it.**

`Notebook.budget.value.minor` is a `bigint`; `JSON.stringify` throws on a bigint, so the plan as
written would crash at the first real proposal with a budget. T2's own test used `emptyNotebook`
and would not have caught it; T5's tests use `withBudget` and would have crashed. T2 gained one
test saving a notebook WITH a budget and reading `requirements_snapshot.budget.value.minor` back
as a string.

**Cost if wrong:** one exported helper, otherwise a crash on the first budgeted proposal.

---

## Task 1 — FK indexes on `escalations`

**Ruling: add indexes on `escalations.turn_id` and `escalations.proposal_id`, though the brief's
SQL omitted them.**

The repo-wide FK-index invariant test (migration 0008's convention) requires an index on every
foreign key, and spec §6 mandates an index on every FK. The brief's migration text did not
include them.

**Cost if wrong:** two small indexes; otherwise the FK-audit test fails.

*Minor deferred:* no column/table comments on `escalations`; `escalations.proposal_id`
references `id` only, not `(id, conversation_id)` — same pre-existing convention as
`gate_results`.

---

## Task 4 — reviewer fence and mask

**Ruling: mask control characters in every supplier-written field reaching the reviewer prompt
(new `maskUntrustedText` in `src/sanitize.ts`, reused by `sanitizeSourceId`) AND wrap the offer
block in the existing untrusted fence via `fenceResult`.**

Review found supplier-written text reaching the reviewer prompt unfenced and unmasked — only ids
were sanitised. Parent spec §4 fences every api/worker-door result on its way to a model, and the
brief under-specified it for the reviewer's own input.

**Cost if wrong:** a supplier-controlled string (a hotel name, a fare's `reason` field) reaching
an Opus-seat prompt unfenced is an injection surface into the one seat whose entire job is to
catch bad offers — the same class of hole the harness closes everywhere else.

Same fix round also addressed three minors: an empty-issues rejection now gets a synthetic issue
naming the cause; issues are joined with `'; '`; `ReviewResult.costMicros` gained a doc comment.
*Minor deferred:* the zod caps on reviewer issues (20 issues / 500 chars) are invisible to the
model, so an over-long legitimate rejection reads back as the generic shape error.

---

## Task 5 — reply wording matches the brief's own test

**Ruling: the reviewer-rejected reply reads "has NOT approved it" rather than the brief's own
"did NOT approve it", so the brief's own `/not approved/i` test matches.**

**Cost if wrong:** none — cosmetic wording, chosen to satisfy a test the brief itself specified.

---

## Task 6 — discriminating test for round-counting, and the inbound leg

**Ruling: two Important findings, both fixed.** (1) No test discriminated that `revise_component`
rows are counted by `countPriorGateRuns` — the brief's own Step 6 check was structurally unable to
fail. Fixed by adding a propose→revise→revise test asserting round 2, with the break re-run to
confirm it fails without the fix. (2) `findShifted` matched only the outbound leg of a flight
(plan-mandated coverage gap). Fixed by extending it to also match the inbound leg's shifted date
and flight numbers when the item has one, with a test using two candidates that share outbound
identity but differ on the inbound leg.

**Cost if wrong:** (1) a broken round-counter for revisions would have shipped with green tests —
the exact "test passes against the wrong implementation" defect class this project tracks. (2) a
`shift` revision on a round-trip item could silently accept a candidate whose return leg did not
actually move, which is a wrong itinerary presented as a correct one.

*Minor fixed same round:* stale `countPriorProposals` comment in `test/schema-corpus.test.ts`.
*Minor deferred:* no driver-level test through the `revise_component` switch case.

---

## Task 8 — the cashier's six-item fix round

**Ruling: fix all four Important findings plus two one-line minors in one round.**

1. **Replay ordering.** Links were minted in itinerary order but read back by `linksForProposal`
   ordered by `item_id`, so "identical text on replay" held only by mock-id luck. Fixed by
   rendering links in itinerary order via an `itemId` lookup against the stored rows.
2. **`SUPPLIER_DOORS` widened.** `hand_off_to_booking` made N supplier `quote` calls as a code
   door, bypassing the per-turn supplier budget entirely. Fixed by adding it to `SUPPLIER_DOORS`
   and gating it in the driver exactly like the `api` doors — one hand-off counts as **one**
   supplier call against the budget; exact per-quote counting against the budget is deferred to
   the backlog.
3. **Masking.** Supplier- and model-adjacent text (item name, reviewer issues, a quote's `reason`,
   `i.supplier`, `BookingUrlError.message`) was rendered unmasked inside a block documented as
   "copy verbatim" — the same fencing gap Task 4 closed for the reviewer, here on the cashier's
   reply. Fixed with `maskUntrustedText` on every such field.
4. **Missing branch coverage.** The `BookingUrlError` path, the hotel `sameIdentity` branch, and a
   supplier-name mismatch had no test. Fixed with three tests.
5. **Empty-itinerary guard.** `mintLinks` had no guard against an empty item set.
6. **Guard order.** `schemaVersion` is now checked before replay, so an old-shaped stored proposal
   fails clearly instead of replaying against the wrong shape.

**Cost if wrong:** (1) a replay that silently reorders links a traveller already clicked through
is a correctness bug in exactly the code the spec calls "the point of no return" — small on its
own, compounding with (3)'s masking gap. (2) an unbudgeted code door lets one turn make unlimited
supplier calls through the cashier alone, defeating the per-turn budget the harness exists to
enforce. (3) same injection class as Task 4, now on the cashier's outbound reply instead of the
reviewer's inbound prompt. (4) untested branches in money-adjacent code.

*Minor deferred:* verification is recomputed on replay rather than recorded; disclosure age drifts
on replay; render shows `priceMinor` not `lineTotalMinor` (safe while `quantity === 1`); legs key
uses `'+'`/`'|'` separators; a redundant `sql.begin` wraps one insert.

---

## Task 8 — currency-mismatch refusal wording matches the brief's own test

**Ruling: the currency-mismatch refusal text was reworded to contain the literal word "currency"
so the brief's own `/currency/i` test matches.**

**Cost if wrong:** none — cosmetic wording chosen to satisfy a test the brief itself specified.

---

## Tasks 10 and 11 — batched dispatch, docs deferred to Task 12

**Ruling: Tasks 10 and 11 were batched into one dispatch as two commits, because their files are
disjoint and both are small. Task 12 (this document) runs AFTER the final whole-branch review so
the decisions doc can include its rulings.**

**Cost if wrong:** none — sequencing only, docs-only consequence.

---

## Task 11 — demo cleanup also removes `model_calls`

**Ruling: `scripts/demo.ts`'s `cleanup()` also deletes `model_calls` rows for the demo user, since
there is no FK cascade from `model_calls` to the conversation being torn down.**

**Cost if wrong:** none — demo-only, never runs against a real user's data.

*Minor deferred:* the demo's replay check prints rather than exits non-zero, matching the file's
existing style.

---

## Final review — four Important fixes

### F1 — `conversations.status = 'escalated'` was not sticky

**Ruling: `completeTurn`/`failTurn` now leave `conversations.status = 'escalated'` alone instead
of overwriting it in the same turn.**

An escalated conversation that also happened to complete or fail its current turn — the two are
independent — silently lost its escalated status, so a paged human's queue item could read as an
ordinary conversation again with no record of why.

**Cost if wrong:** a human-in-the-loop escalation becomes invisible to whatever reads
`conversations.status`, in exactly the path that exists so a human notices.

### F2 — the disclosure path could not build a real-supplier link

**Ruling: `StoredItineraryItem` gains `bookingUrl`; `storedAsItem` no longer sets it to `null`.**

`hand_off_to_booking`'s disclosure path (item is not re-quotable) needs a link to show her even
when it cannot verify the price, and the stored item shape had nowhere to carry the URL the
supplier port already knows how to build.

**Cost if wrong:** the disclosure copy — "check the total before you pay" — would have no link to
attach the warning to, defeating the purpose of the disclosure path.

### F3 — reviewer issues reached the driver transcript unmasked

**Ruling: reviewer issue text is masked with `maskUntrustedText` in `proposalPath.ts` before it
reaches the driver's tool-result text (the `Revise:` reply and the `shipped_unapproved` reply).**

The reviewer's own issue text can itself contain supplier-derived strings it is quoting back
(e.g. a hotel name it flagged), so the same fencing gap Task 4 closed for input into the reviewer
existed one hop further downstream, into the driver.

**Cost if wrong:** an injection surface reopens one hop downstream of where Task 4 closed it —
the reviewer's own rejection text becomes an unmasked channel into the driver's context.

### F4 — `spent.micros` was lost when `run()` threw after the reviewer call

**Ruling: the reviewer-spend fold moves into a `finally`, so it runs whether `run()` resolves or
throws.**

The accumulator introduced by Deviation 4 sat inside the success branch only; a throw after the
reviewer had already been billed lost that spend from `turns.spend_usd_micros` — money already
spent with the provider, unrecorded on the turn.

**Cost if wrong:** every crash after a reviewer call silently under-reports the turn's true spend
against the daily and per-conversation ceilings — a money-guardrail defect, the class this
project treats as worst-in-kind.

Same fix wave also addressed: a `model_calls` multiset assertion (T5's earlier "id tiebreak" fix
was wrong — `id` is a uuid, not orderable that way — replaced by a multiset assertion);
`markNotified` moved outside the notifier's own try; the render path now refuses on an incomplete
link set rather than rendering a partial one; a `driver.md` sentence on the `Revise:` reply;
a test pinning `ESCALATION_REASONS` against the 0014 check constraint; and a comment on
`sameIdentity` naming departure dates explicitly.

---

## Deviation 1 conflicts with the parent spec §5 point 6

The parent spec's §5, point 6 says plainly: **"Link emission is the point of no return. After it,
nothing may mark the turn failed, nothing may re-quote that set, everything is best-effort."**

What was built does not hold that line. A crash between the `link_clicks` commit and
`finishToolCall` fails the turn `fenced` — the turn IS marked failed, in the narrow window between
the mint transaction's commit and the worker closing out the `tool_calls` row. The links
themselves are safe: they are committed, and recoverable by `proposal_id` on the next turn, so no
money and no link is lost. But the letter of §5.6 is violated for that window.

The alternative considered and rejected for this plan: let the resumed turn's `ambiguous` outcome
re-run `hand_off_to_booking` instead of failing. That is legitimate here specifically because
`hand_off_to_booking` mints links idempotently by `proposal_id` — a re-run would find the existing
rows and return them rather than minting a second set. But "`ambiguous` re-runs the tool" is a
change to a harness-wide rule (how the worker treats a `pending` `tool_calls` row on resume), not
a change local to this tool, and changing a harness rule for one tool's benefit was judged out of
scope for this plan. It is filed in the backlog as a candidate change for whoever next touches the
worker's resume path.

**Cost if wrong** (i.e., if the crash-between-mint-and-finish window turns out to matter in
practice): a turn that would otherwise have completed cleanly instead reads `fenced`, and whatever
surfaces that to her has to explain "this failed, but check your links" rather than "this
succeeded." The links and the money are never at risk — only the turn's own status word.

---

## Final review — parked residuals

### Parked — `markNotified` failure after a successful notify fails the turn

The row exists, the human has been paged, but if the follow-up `markNotified` write fails, the
turn still fails on that write, losing the reply though the escalation itself already landed.

**Ruling:** real but bounded; filed as a backlog row for a one-line `.catch` later.

**Cost if wrong:** one lost reply on a DB blip, on an already-escalated conversation where a human
has already been notified — the escalation itself is not lost, only the turn's own completion.

### Parked — the sweeper's crash-loop reap overwrites `'escalated'`

`sweeper.ts`'s crash-loop reap sets `conversations.status = 'failed'` unconditionally, the same
class of overwrite F1 fixed inside `completeTurn`/`failTurn` — but the sweeper is plan 1 code,
outside this plan's file map.

**Ruling:** filed as a backlog row rather than fixed here.

**Cost if wrong:** an escalated conversation that also crash-loops reads `'failed'` instead of
`'escalated'`, the same visibility loss as F1 but from a different writer.

### Parked — `StoredItineraryItem.bookingUrl` not backfilled on pre-fix rows

F2 added the field going forward; no pre-fix rows exist in the live database (unshipped), so there
is nothing to backfill.

**Ruling:** no action.

**Cost if wrong:** none — the condition that would require action does not exist.
