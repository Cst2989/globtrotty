# Plan 3b — The gates half: reviewer, revision, cashier, escalation

**Date:** 2026-09-13
**Status:** Approved for planning
**Parent spec:** `2026-08-15-globetrotty-design.md` (binding). This document narrows §3–§5 and §7
of the parent to one plan and records the rulings taken to do so. Where the two disagree, the
parent wins and this document is wrong.
**Scope:** the four tools that sit on the `propose_itinerary` path. The new seats (front desk,
scouts), the drift monitor, CI, and `trimForContext`'s price half go to plan 3c.

---

## 0. The finding that shapes this plan

**Nothing writes `proposals` today.** `propose_itinerary` runs the seven gates and returns text
to the model; the parent spec's `saveProposal` was never built, and `proposals`, `link_clicks`
and `gate_results.proposal_id` have never carried a row. Every component in this plan sits on a
proposal row, so saving one is task 1 and everything else depends on it.

Verified: `grep -rn proposals src` returns nothing at all.

## 1. Components

```
propose_itinerary ─┐
                   ├─► runGates ─► reviewOffer ─► saveProposal ─► proposal_id to the model
revise_component ──┘      (7 rows)    (1 row)       (1 row)

decideProposal (repo, not a tool) ─► proposals.decision / decided_at

hand_off_to_booking(proposal_id) ─► cashier ─► link_clicks rows ─► links to the model

escalate_to_human(reason) ─► escalations row ─► Notifier port
```

Each box is one module with one purpose. The driver's `case` for each tool is a thin call into
it, the way `propose_itinerary` already calls `runGates`.

## 2. Save the proposal

`saveProposal(sql, args)` in `src/repo/proposals.ts` inserts one row after the gates and the
reviewer have both run:

| column | source |
|---|---|
| `itinerary` | the `RehydratedItem[]` the gates returned — never the model's refs |
| `itinerary_schema_version` | `1` |
| `requirements_snapshot` | the notebook as passed to `constraintsFromNotebook` |
| `total_minor`, `currency` | the gates' server-computed total |
| `gate_outcome` | `approved` or `shipped_unapproved` (§3) |
| `review_rounds`, `review_issues` | from the reviewer (§3) |
| `prompt_version`, `model_config_id` | the driver seat's, so slice 2 can group by era |
| `parent_proposal_id` | null, or the proposal a revision was derived from (§4) |
| `turn_id`, `conversation_id`, `user_id` | from the turn context |

The `gate_results` rows already written by `runGates` gain the `proposal_id` after the insert,
via one `update ... where turn_id = $1 and round = $2`. Rows for rejected proposals keep
`proposal_id = null`: there is no proposal to point at, which is what `gate_outcome = 'rejected'`
would otherwise have to fake. **`gate_outcome = 'rejected'` is therefore never written by this
plan** — the check constraint keeps it for a future writer.

The tool result to the model carries the `proposal_id`, because `revise_component` and
`hand_off_to_booking` take it and nothing else.

## 3. The reviewer seat

**Seat:** `SEATS.reviewer` (Opus 5, `high`, `reviewer@1`), already declared. Called through the
existing `callModel` with `reserve` before and `reconcile` after, exactly as the driver is —
**the fourth caller of the three money doors, and no new door.** `capture_policy` is already
hardwired `full` for this seat.

**Input:** the rehydrated items rendered as text (supplier, name, dates, price with age, slot),
the notebook rendered by the existing `renderNotebook`, and the server total. The reviewer sees
prices because they are the corpus's, not the model's.

**Output:** a fixed shape, requested through the API's structured-output field on the request:

```ts
{ approved: boolean; issues: string[] }   // issues non-empty iff !approved
```

`buildRequest` grows an optional `outputSchema` on `CallArgs`; the request-surface test pins the
exact field the API expects (plan 3, lesson 2: the SDK's types do not track the request surface,
so a test does). No assistant prefill — it 400s on Opus 5.

**Rules, each a test:**

- A `refused` result, a parse failure, a missing block, or `approved: true` with non-empty
  issues is a **rejection with a synthetic issue** naming the cause. Never approval.
- One `gate_results` row with `gate = 'reviewer'` per call, at the same `round` as the seven
  gate rows, `passed` true/false, `detail` = the issues joined. (`'reviewer'` is in the column
  check but not in `GATE_NAMES`, so it coexists with the seven-row set.)
- The reviewer is **only called when the seven gates pass.** A gate rejection returns to the
  model without spending an Opus call.

**Rounds.** `MAX_REVIEW_ROUNDS = 2`. The count of prior reviewer verdicts in this turn is
derived from `gate_results` (`gate = 'reviewer' and turn_id = $1`), which is persisted before
any later step and survives a crash. `TurnState.reviewRounds`, declared in plan 3 and
incremented by nothing, is **removed** — two persisted counters of the same thing is one too
many.

- Verdict rejected and prior verdicts `< MAX_REVIEW_ROUNDS`: the tool result is
  `Revise: <issues>`, no proposal is saved, and the model proposes again (which is a new gate
  run at the next `round`).
- Verdict rejected and prior verdicts `>= MAX_REVIEW_ROUNDS`: save with
  `gate_outcome = 'shipped_unapproved'`, `review_issues` filled, and tell the model in words it
  must pass on: the reviewer's concerns go in the reply to her, unresolved.
- Approved: save with `gate_outcome = 'approved'`.

## 4. `revise_component`

**Input** (zod, strict):

```ts
{ proposalId: string; change:
    { kind: 'swap'; slot: SlotName; sourceId: string }
  | { kind: 'shift'; days: number /* integer, -14..14, non-zero */ } }
```

`swap` replaces the item in one slot with another corpus reference. `shift` is honoured only
when the corpus holds items for the shifted dates: the tool rebuilds the reference list by
looking up, per item, a `tool_results` row with the same supplier, same native identity fields,
and dates moved by `days`. Any slot that cannot be resolved rejects the whole revision with the
unresolved slots named, and the model is told to search those dates first. **The tool never
calls a supplier**; it is a code door over the corpus, like `propose_itinerary`.

**Then the identical path as §2–§3:** `runGates` → reviewer → `saveProposal` with
`parent_proposal_id` set. The parent row is never mutated.

**Round bookkeeping.** `countPriorProposals` becomes `countPriorGateRuns` and counts
`propose_itinerary` **and** `revise_component` calls, excluding the current call id. This is the
precondition migration 0013 documents; the test creates one of each in a turn and asserts the
second lands at `round = 1`, then removes the second tool name from the count and watches the
insert collide.

**Preconditions:** the parent proposal must belong to this conversation (the existing
`unique (id, conversation_id)` is the join). A proposal already carrying a `decision` may still
be revised; the revision is a new undecided row and the cashier will refuse it until decided.

**Migration 0014** adds `proposals.parent_proposal_id uuid references proposals(id) on delete
set null` and its index.

## 5. Recording her decision

`decideProposal(sql, { proposalId, conversationId, decision, rejectReason? })` in
`src/repo/proposals.ts`. Writes `decision`, `decided_at = now()`, `reject_reason`, and on accept
copies `total_minor`/`currency` into `accepted_total_minor`/`accepted_currency`. Refuses (throws)
if the row is not in this conversation or already decided.

Not a tool. The plan 4 route handler calls it from her button; `scripts/demo.ts` calls it to
show the cashier. Both go through one door so the 30-minute window has one clock.

## 6. The cashier — `hand_off_to_booking`

**Input:** `{ proposalId: string }`. Nothing else is accepted; an itinerary in the payload is a
zod rejection.

**Order of checks, each its own refusal text:**

1. Row exists in **this** conversation.
2. `decision = 'accept'` and `decided_at >= now() - 30 minutes`. The window is a named constant
   with one definition.
3. `gate_outcome = 'approved'`. A `shipped_unapproved` proposal can be accepted by her but is
   handed off with the reviewer's issues repeated in the reply — it is not refused, because
   refusing would make the exhausted-rounds path a dead end she cannot leave.
4. Per item, `supplier.quote(sourceId, item.searchParams)` for the item's supplier. Items with
   `searchParams = null` cannot be re-quoted and **block** — unknown is not unchanged.
5. Any outcome other than `{status: 'ok'}` blocks the whole hand-off, naming the item.
6. Per item: same supplier, same native identity (flight numbers and dates for a flight; property
   and check-in/out for a hotel), same currency, and `|new − old| × 10 000 ≤ old × 50` in minor
   units — ±0.5% in integer basis points, no floats. A cheaper fare that changed identity blocks.
7. Build URLs and mint links (below), then return them.

Step 4 only runs when the supplier's `capabilities.mayRequote` is true. When it is false the
hand-off **does not claim verification**: the reply says what each item cost and how long ago,
and that she should check the total before paying. The mock supplier already simulates both
modes.

**URLs.** The `Supplier` port gains `bookingUrl(item: StoredItem, trackingRef: string): string`.
Kiwi returns the item's own `bookingUrl` with the tracking ref appended as the affiliate sub-id
parameter; SearchApi hotels build a Google Hotels URL from `property_token`. Each
implementation asserts the final hostname against a per-supplier allowlist and throws
otherwise — a supplier that returns a URL off its own domain is a supplier we do not link to.
The mock returns `https://mock.example/…`.

**Minting is the point of no return.** In one transaction: insert one `link_clicks` row per item
(`tracking_ref` minted first and embedded in the URL, `quoted_minor` = the fresh price,
`url` = the exact string emitted), and `finishToolCall` with the links as the result. A resumed
turn that finds the `tool_calls` row `done` replays the stored links and re-quotes nothing.
After the commit nothing may fail the turn: the reply is assembled from the stored rows.

The cashier moves no money and writes no spend row.

## 7. `escalate_to_human`

**Input:** `{ reason: EscalationReason; proposalId?: string }` where

```ts
type EscalationReason =
  'supplier_unavailable' | 'price_moved' | 'user_request' | 'safety' | 'cannot_satisfy'
```

No free text from the model reaches the row.

**Migration 0014** adds `escalations` (`id`, `conversation_id`, `user_id`, `turn_id`,
`proposal_id` nullable, `reason`, `created_at`, `notified_at` nullable) with the same
`(conversation_id, user_id)` composite FK the other tables use, and a `(user_id, created_at)`
index for the rate limit.

**Rate limit:** 3 per user per UTC day, counted from the table fail-closed (a failed count is a
refusal). Over the limit the tool returns a refusal; the model is told she can be reached
another way, and the conversation status is untouched.

**Effect:** insert the row, set `conversations.status = 'escalated'`, then call the `Notifier`
port. `Notifier` is `{ notify(e: Escalation): Promise<void> }`; the only implementation in this
plan logs. The call is best-effort and swallowed the way spans are: an escalation that could not
be sent is still recorded, `notified_at` stays null, and a later job can retry. The row and the
status change commit before the notifier is called. Idempotent via `tool_calls`.

`Notifier` enters through `DriverDeps`; no environment key is added.

## 8. Driver prompt

`driver.md` gains the three tools' contracts in the model's terms: propose, get a
`proposal_id`, revise by id, and hand off by id **only after she has accepted in chat** — the
tool refuses otherwise and the refusal text says why. `DESK_TOOLS.planning` gains the three
names. The prompt version becomes `driver@2`, so `model_config_id` groups separate the eras.

## 9. Testing

All tests run against `MockSupplier` and the stub transport, in `test/`, following the existing
per-module files.

- **Every gate rule is a discriminating test**: implement the rule, break it (flip the
  comparison, drop the check), watch the test fail, restore. The plan lists the break per test.
- **Reviewer:** approval, rejection with issues, refusal-as-rejection, malformed-as-rejection,
  round exhaustion writes `shipped_unapproved`, second proposal in a turn lands at `round = 1`
  with its own reviewer row.
- **Revision:** swap resolves, shift resolves when the corpus has the dates, shift rejects
  naming slots when it does not, lineage recorded, the collision test in §4.
- **Cashier:** each numbered refusal in §6 as its own case, using `quoteMode` and
  `quoteDriftMinor` on the mock; tolerance at exactly 0.5% passes and one basis point over
  blocks; identity change with lower price blocks; `mayRequote = false` produces disclosure and
  calls `quote` zero times; replay returns stored links and calls `quote` zero times.
- **Escalation:** row written, status set, fourth call in a day refused, notifier failure leaves
  the row.
- **Money:** the reviewer's calls appear in `model_calls` with `seat = 'reviewer'` and the
  conversation spend delta equals the summed `cost_micros`. No new test on the cashier's spend
  because it has none — asserted by a test that the spend is unchanged across a hand-off.
- **Request surface:** `buildRequest` with `outputSchema` produces the exact field name, pinned
  against a recorded live response in the `LIVE_MODEL=1` suite.

## 10. Rulings taken here, and what they cost if wrong

| Ruling | Why | Cost if wrong |
|---|---|---|
| Revision is a new row with lineage | the accepted snapshot and the shipped itinerary can never diverge | one nullable column |
| Review round count derives from `gate_results`, `TurnState.reviewRounds` removed | one persisted source; crash-safe | none: the field was never read |
| `gate_outcome = 'rejected'` never written | rejected proposals have no row to describe | slice 2 counts rejections from `gate_results`, which it already must |
| `shipped_unapproved` can be handed off, with issues repeated | otherwise round exhaustion is a dead end | she can book an offer the reviewer disliked, which the parent spec already permits |
| Escalation is record-only behind a port | nothing is deployed; a provider would widen the all-or-nothing env loader | one adapter file later |
| `bookingUrl` lives on the supplier port | the supplier knows its own URL shape and its own hostname | the port grows a method the mock must also implement |
| 30-minute accept window, 3 escalations/day, ±0.5% | parent spec's numbers, or the smallest that lets a demo run | constants with one definition each |
