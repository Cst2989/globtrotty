# Supplier Port and Gates — decisions taken during execution

Rulings made while executing `docs/superpowers/plans/2026-08-16-supplier-port-and-gates.md`,
recorded because they were taken on the author's behalf so the work could continue. Same
format as `2026-08-16-harness-foundation-decisions.md`: what was decided, why, and what it
costs if it was wrong.

Branch: `feat/supplier-port-and-gates` · 12 tasks, each reviewed individually, then a
whole-branch review that found four Important issues no single-task review could see.

---

## Deviation from spec §6 — `tool_results` is upsert-only, not append-only

**Ruling: the deviation STANDS for this branch. Recorded here and in
`src/repo/toolResults.ts`'s doc comment rather than fixed.**

Spec §6 says of `tool_results`: *"Untrimmed, append-only, retained at least as long as
`model_calls`."* `recordResults` uses `insert ... on conflict (conversation_id, source_id)
do update`, which overwrites `price_minor`, `currency`, `payload` and `fetched_at`. That is
upsert-only. The difference is real and it destroys data: when a re-search moves a price,
the previous quote for that `(conversation_id, source_id)` is gone.

**Why the upsert exists at all, and why `do nothing` is not the answer.** The freshness gate
tells the model "these prices are older than we will quote, re-search them". The re-search
must be able to move `fetched_at`, or the gate rejects the retry for precisely the reason
the retry existed. A `do nothing` conflict path deadlocks the one loop the gate stack is
built around.

**Why it was not converted to row-per-fetch in the final fix wave, and why this is a
deviation from the spec rather than a resolution of one in it.**

§6's `tool_results` entry is two sentences, not one: the column list `(conversation_id,
source_id), ...` ends with a full stop, and *"Untrimmed, append-only, retained at least as
long as `model_calls`"* is a separate sentence about retention and mutability. §6 never calls
`(conversation_id, source_id)` a key, a primary key, or unique for this table — compare
`tool_calls`' *"(turn_id, call_id) primary key"*, `turns`' *"unique (conversation_id,
idempotency_key)"*, and `link_clicks`' *"unique (proposal_id, item_id)"*. The bare tuple on
`tool_results` names the row's identifying grain, not an asserted constraint, and a lookup
key is not the same thing as a uniqueness constraint: a row-per-fetch table still keeps
`(conversation_id, source_id)` as its lookup key, it just loses uniqueness on it. §6 also
calls `model_calls` *"the append-only cost ledger"*, a table that is unambiguously
insert-only, so "append-only" means what it plainly says here too. **The spec is not in
tension with itself.**

The uniqueness requirement comes from **this branch's own plan**, not the spec:
`docs/superpowers/plans/2026-08-16-supplier-port-and-gates.md:141` says *"It is append-only
and untrimmed — the model sees a trimmed view, the gate sees this. `(conversation_id,
source_id)` is the lookup key, and it must be unique so rehydration is a point read."* That
sentence asserts both append-only and unique together, and the plan's own DDL then
implements only the unique, upsert half (`on conflict (conversation_id, source_id) do
update`). The plan created the tension the spec does not have; it did not resolve one that
was already there.

So the reasons the conversion was deferred stand on their own, not on a misreading of §6:

1. **Reversing a live table's key is out of scope for a fix wave.** Dropping a unique
   constraint on a LIVE table, rewriting the gate stack's only corpus reader, and changing
   the corpus's growth profile is a structural change to the branch's central table — it
   belongs in a task with its own review, not a slot in a fix wave.
2. **Nothing reads a superseded row yet.** An approved proposal's prices survive in
   `proposals.itinerary` (rehydrated, never the model's version); a gate run's own evidence
   survives in `gate_results.detail` / `source_ids`. The gap is narrower than "no history":
   it is the exact corpus inputs to a REJECTED proposal, for an item that was later
   re-quoted.

**What it costs, and why the obligation is firm.** Every re-quote between now and a
conversion destroys one historical price, silently and unrecoverably. Unlike a code defect
this cannot be fixed retroactively — the rows lost in the meantime never come back. Because
the spec is not actually ambiguous here, this is a debt owed against §6, not an open question
to revisit — doing the conversion EARLY is much cheaper than doing it late, and every day it
waits is more history silently gone.

## Deviation from spec §5's `quantity` mental model

**Ruling: `checkTotals` requires `quantity === 1` and files a `totals` violation otherwise.
No `SupplierItem` field describing what the price covers was added.**

§5 describes `quantity` as a count of identical units ("3 seats, 7 nights"). Neither shipped
adapter prices that way, verified against the captured fixtures:

- **Kiwi** — fixture search is `2 adults`, itinerary `price: 464`. €464 is the PARTY total.
- **SearchApi** — the adapter reads `total_price`, the whole stay; `nights` is derived from
  the requested window and is descriptive, never a multiplier.
- **MockSupplier** mirrors both.

So `1` was already the only correct quantity anything in this branch could produce, while
the model controlled an integer 1–16 that the server multiplied straight into the trip
total. A `quantity: 16` proposal returned a 16× total with `gate_results` recording
`totals: pass` — the one hole in the branch's guarantee that no price the model writes
reaches the user.

The alternative considered was a `priceCovers: 'whole_booking' | 'per_unit'` field on
`SupplierItem`, set by each adapter and read by the gate. Rejected for now because every
supplier in the repository would set the same value: a single-valued discriminator carries
no information, and it buys an unexercised code path plus a column on a live table.

**CARRY TO A LATER PLAN:** the first genuine per-unit supplier (a per-seat fare, a per-night
rate) must add that field rather than loosening the check globally, so the answer travels
with the item instead of being a global assumption. The reasoning and the fixture evidence
are at the check itself in `src/gates/checks.ts`.

## Carried forward

- **CARRY TO PLAN 3/4:** if slice 2's replay needs "the price the gate actually saw", convert
  `tool_results` to row-per-fetch: drop `unique (conversation_id, source_id)`, add
  `(conversation_id, source_id, fetched_at desc)`, make `recordResults` a plain insert, and
  make `rehydrate` a `distinct on`. Cheaper the sooner it happens.
- **CARRY TO A LATER PLAN:** `priceCovers` on `SupplierItem`, with the first per-unit
  supplier. See above.
- **CARRY TO PLAN 4:** `daily_usage` now carries a table comment warning that a per-user RLS
  policy silently breaks the global daily ceiling. Read it before writing any policy.
