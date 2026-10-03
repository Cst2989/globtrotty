# Plan 5 — Results first — decisions taken during execution

Rulings made while executing `docs/superpowers/plans/2026-10-03-plan-5-results-first.md`,
recorded because they were taken on the author's behalf so the work could continue. Same format
as `2026-09-19-plan-4-chat-decisions.md`: what was decided, why, and what it costs if it was
wrong.

Branch: `feat/plan-5-results`, base `fdd7ae3` (main) · 10 code tasks. Tasks 5, 6, 7 and 8 each took
one scoped per-task review (7's review was folded into the final one, by the pace ruling); Tasks
3, 4, 9 and 10 got a controller spot-check instead of a per-task review; Task 1 and 2 each took a
fix round after a full review. Then a whole-branch final review (opus, at `89e9930`) that returned
four Critical, five Important and eight Minor findings plus seven unrecorded deviations, addressed
in one fix wave (`89e9930..85afcc4`, 12 commits, one per item) with no scoped re-review requested
by the controller afterward. **1181 tests passing, 14 skipped** (live external-API suites, gated)
at the head of the branch, up from the 1154/14 baseline at the final review and the 996/13
baseline at Task 1. Typecheck clean across all three passes; `pnpm lint` clean, 0 problems;
`pnpm build` clean, `ƒ /api/conversations/[id]/choose` in the route list. Migration **0018**
applied to the live Supabase project (Task 1); migrations 0001–0018 are now live.

This document is the records pass only (Task 11, docs-only slice): no code changed to produce it.

---

## Pre-flight ledger rulings (before any task started)

1. **`IntakeOutcome.choices` carries `questionId`** (`'origin' | 'destination' | 'outbound'`),
   matching `ChoicesContent.questionId` — the router needs it to merge her click. **Cost if
   wrong:** one extra string field.
2. **Intake sets `conversations.desk = 'planning'` at the END of every run**, brief or choices (the
   front desk's old job, "see the first message once", is done either way). The router treats a
   newest-row `choice` action as "run intake again on the original message with
   `overrides: Record<questionId, optionId>` applied after Jev's answers at confidence 1" —
   `runIntake(deps, text, today, lastOrigin, overrides = {})`. **Cost if wrong:** a re-run costs
   one more Jev call (~$0.0001).
3. **The Kyoto side trip maps to metro `OSA`** (Kansai) — Kyoto has no airport of its own; hotel
   searches use the place NAME ("Kyoto"), not the code, so `Place` gained `hotelName` (defaults to
   `city`). **Cost if wrong:** a hotel search for Osaka instead of Kyoto, visible in the list
   header.

---

## The pace ruling, and what it skipped

**Ruling (after Task 2's review): the author asked for speed. From Task 2 onward, per-task reviews
are run only for Tasks 5, 6, 7 and 8** (money, the operator channel, the model seat) — **Tasks 3,
4, 9 and 10 get a controller spot-check instead** (tests run, diff skimmed, no findings list), **fix
rounds get no scoped re-review unless the finding was Critical, and the whole-branch final review
stays.** Task 3 was allowed to start before Task 2's own fix round landed, because the two touch
disjoint files and every implementer was told to stage only their own files.

**Cost if wrong:** a defect in Tasks 3, 4, 9 or 10 reaches the final review instead of being caught
at a task gate — which is exactly what happened: Task 9's `flight.stops`-from-the-outbound-leg-only
choice (I3) and Task 10's inert choice card (the LOAD-BEARING gap) both went unreviewed until the
whole-branch pass, and both turned out to need a fix. Nothing the spot-check pace skipped was
itself a Critical; the Criticals (C1–C4) all live in Tasks 5–8's own files or in code the pace
ruling's own per-task reviews did cover and missed (C1 was introduced by Task 8, reviewed, and its
*price* was fixed at that review — its *model choice* was not caught until the final pass because
the operator-channel interaction crosses into Task 4's and the worker's territory, outside Task
8's own review scope).

---

## Task 1 — migration 0018 and the Jev client

**Status:** complete (commits `fdd7ae3..129cdbf` + fix round `9612556`; review clean after the fix
round).

**Deviations (from the implementer's own report):**
- `test/schema-5.test.ts`'s constraint-lookup query scopes `pg_constraint` to `public.*`. The live
  Supabase project also hosts an unrelated `course` schema with same-named tables
  (`model_calls`, `messages`) and colliding constraint names, so an unscoped catalog query reads
  the wrong row. Carried forward into every later task's schema-catalog query.

**Review findings and fixes:**
- Important: `test/web-config.test.ts`'s `FORBIDDEN_NEEDLES` lacked `'JEV_KEY'` — the sentinel that
  must fail if a secret name leaks under `app/`/`web/` had no enforcement for the new key. Fixed in
  the round 1 commit (`9612556`): `JEV_KEY` added to the list.
- Minor (deferred): a timeout in `askJev` surfaced as a raw `AbortError`, not a `JevError`;
  repeated external `signal` listeners accumulate (no `{ once: true }` cleanup on the abort
  controller's own listener in one path). Fixed in the same round 1 commit rather than deferred
  further — the ledger's "Task 1: fix round 1/5 (2 addressed, 0 open)" entry covers both.

Fix round 1/5: 2 addressed, 0 open — sentinel `JEV_KEY`, timeout surfaced as `JevError`; commit
`9612556`.

---

## Task 2 — places and candidates

**Status:** complete (commits `129cdbf..a0c24dd` + fix round `d8fc286`; no re-review per the pace
ruling, findings were addressed and the fix round's own 26 tests cover them).

**Deviation (from the implementer's own report):** `places.json` landed at exactly 300 entries by
trimming two minor cities (Milwaukee, Nouméa) rather than any principled "300th" cut — OurAirports'
`large_airport` classification is runway-length infrastructure, not passenger-traffic ranking, and
the source CSV carries no traffic/population column, so "the 300 busiest metro areas" (plan Task 2
Step 1) has no single defensible ordering to cut at 300. See backlog 5.9.

**Review findings:**
- Critical: exact alias matches fired on everyday English words — "nice" (Nice), "male" (Malé),
  "split" (Split), "cologne" (Köln), "la" (Los Angeles abbreviation); fuzzy matching let "parks"
  match PAR; 3-letter month/weekday abbreviations matched common words standing alone ("sun",
  "sat", "wed", "may").
- Important: San Jose (California, `SJC`) vs San José (Costa Rica, `SJO`) alias collision; a stray
  comment mis-scoped Istanbul's region; upper-case English-word codes could match lower-case text
  (`WAS`, `CAN`, `SAT`).
- Minor (deferred): the fuzzy scan is linear over ~300 keys (~55 ms on a 4,000-character message);
  the places-table build script has no offline fallback if the OurAirports dataset is unreachable.

**Ruling: candidates stay over-finding by design** (Jev chooses, always with a `none` option), but
a match that is also an everyday English word needs a cue to survive: a travel
preposition/verb within two tokens, or a mid-sentence capital. A fuzzy match needs the cue AND a
stop-word check; a 3-letter month/weekday abbreviation needs an adjacent day number. **Cost if
wrong:** a cued-less mention like "Nice in May" at sentence start still matches (the capital rule
covers it), but "nice beach town in may" does not — Jev then sees fewer candidates than ideal, and
the choice card covers the miss.

Fix round 1/5: 6 addressed, 0 open — cue/stoplist guards, the San Jose alias, the Istanbul region
comment; commit `d8fc286`; 1023 passed. No re-review per the pace ruling.

---

## Task 3 — date resolution and the brief

**Status:** `DONE_WITH_CONCERNS` (commit `2dba446`; 1037 passed; one `LIVE_JEV` live test, 1/1
passing). Spot-checked per the pace ruling, not independently reviewed.

**Deviations (from the implementer's own report, both additive and non-breaking):**
- `buildIntakeQuestions` takes a third argument, `today: Date` — the brief's own Step 2 code
  snippet uses a free variable `year` with no definition, and the function must produce the
  `outbound_year` criteria (`{[String(year)]: null, [String(year+1)]: null, ...}`), so `today` is
  the only available source.
- `assembleBrief` takes an optional 5th argument, `outboundOverride?: string`, to satisfy ledger
  ruling 2 ("for the `'outbound'` questionId the override value is an ISO date used directly") —
  there is no single Jev answer key called `outbound` to overwrite before assembly (it is built
  from five separate fields: month/day/year/weekday/relative), so `runIntake` threads the override
  straight into `assembleBrief`, bypassing both date resolution and the arrive-by day-earlier
  adjustment.

**Concerns the implementer flagged, and how each was closed:**
- **(c) REAL QUIRK, load-bearing for the author's own message:** the `outbound_day` question
  lacked the `"(arrival or departure)"` qualifier that `outbound_month` carries, so a message
  explicit about an arrival deadline (the author's own Tokyo message) drops `outbound_day`'s
  confidence below 0.6 while pushing `arrive_by` above it. **Ruling:** Task 5 fixes the wording —
  `outbound_day` gets the same qualifier, and `arrive_by`'s instructions clarify "the day she must
  BE THERE; the date itself is still the outbound date" — then re-records the fixture with the
  author's verbatim message and asserts the brief on it. **Cost if wrong:** one more live
  recording. Closed: Task 5's commit `023b14c` re-recorded the Tokyo fixture after the wording fix
  (outbound_day 1.0, arrive_by 0.61, outbound_year 0.53, rest 0.95–1.0).
- **(d)** the `'outbound'` choice-card branch and the `outboundOverride` re-run path were
  implemented per the brief's prose and the ledger rulings but exercised by no test in this task.
  **Ruling:** covered by Task 6's router tests (the override path) and a Task 5 unit test (the
  outbound choice card). Closed by both.

(a) and (b) — `assembleBrief`'s optional-argument shape and the "year assumed from today, else the
code's nearest-future rule" split — were not findings against the brief, just implementation
choices the implementer flagged for visibility; neither needed a ruling.

---

## Task 4 — results and choices rows, worker hydration, step attachments

**Status:** complete (commit `7fc4787`; 1034 passed). Controller spot-check, not independently
reviewed: renderers mask ids/control chars, hydration branches present, attachments written with
`clock_timestamp()`, both action arms strict.

**Deviation (noted, not a ruling):** `src/results.ts` imports `Cabin`/`Assumption` from
`src/intake/brief.ts`, which Task 3 had not yet committed at the time Task 4 was built — the tree
at `7fc4787` alone does not typecheck; it typechecks once Task 3 lands, and both land in this
branch before any merge. This matches the brief's own stated resolution ("if `brief.ts` already
exists when you commit, import from it instead and do not duplicate").

---

## Task 5 — the intake agent and re-rank

**Status:** complete (commits `023b14c` + fix round `2842fb2`; re-review clean).

**Note:** Task 8 ran concurrently in the same worktree (by the pace ruling); both implementers
staged only their own files and there was no collision.

**Deviation:** no `cabin` notebook key exists in `src/notebook.ts` (off-limits to this task's
implementer). Cabin stays in the brief and the results row only, never written to the notebook.
Recorded as a concern, not fixed in-task; carried to backlog.

**Review findings and fixes:**
- Critical: `rank.ts`'s `summary()` passed Kiwi's raw `cabinClass`, `departLocal` and `arriveLocal`
  strings to Jev unmasked — a trust-boundary break (supplier strings must go through
  `maskUntrustedText`/validation before reaching a model, including Jev). Fixed in round 1: all
  three masked/validated before the Jev call.
- Important (2): `setDesk(sql, ..., 'planning')` ran BEFORE the unguarded `rankItems`/
  `recordResults`/`writeBrief` sequence, so a throw in any of those three left the conversation
  stranded at `'planning'` with no notebook, no results row, and the intake Jev cost never reaching
  `recordSpend`. Fixed in round 1: `setDesk` moved to the end of both return paths, and
  rank/record/writeBrief wrapped so any throw returns a `fail` step carrying the accumulated Jev
  cost.
- Important (3): the direct supplier search bypassed the existing per-turn supplier budget and
  wrote no `tool_calls` row, though spec §1.4 requires the existing budget to cover it. Fixed in
  round 1: the search now runs under `assertSupplierBudget` and a `tool_calls` row via the existing
  repo helpers — "the same as the driver's door."
- Minor (deferred): the choices test did not assert zero `tool_results`/notebook writes; cabin
  absent from the notebook (the same gap as the implementer's own concern above).

Fix round 1/5: 4 addressed, 0 open — mask the rerank state, `setDesk` last, budget + `tool_calls`
row, a choices test; commit `2842fb2`; 1125 passed. Scoped re-review dispatched (Critical was among
the findings) and came back clean.

**Note carried in the ledger:** a `tool_calls` row stays `'pending'` when the search itself throws
— the sweeper/ledger semantics the driver already uses; acceptable, not a finding.

---

## Task 6 — the router and filters

**Status:** `DONE_WITH_CONCERNS` (commit `4f655a9` + fix round `0b2dd6a`; 1065 passed at the
implementer's own gate, one failure in the web-config sentinel caused by a concurrent
implementer's uncommitted `web/data.ts` change, not this task's own files).

**Concerns the implementer flagged, and disposition:**
1. **`new_search`'s notebook merge covers origin only.** The brief's resolution paragraph says "the
   brief merges with the notebook: a field Jev marks unstated keeps the notebook value" for
   origin/destination/dates/party. Only the `origin` half was built, via a `lastOrigin` parameter
   threaded into `runIntakeTurn` (preferring `notebook.originCity.value` over
   `readLastOrigin`'s cross-conversation lookup). Destination/dates/party have no such fallback —
   widening `assembleBrief`'s signature for all four felt too large and speculative a change to
   make unreviewed under this task, and `src/notebook.ts` itself was off-limits (another
   implementer's file). **Ruling: accepted as partial for this plan** — a `new_search` message
   restates what changes, and Jev's `unstated` on the rest falls to defaults shown as assumption
   chips she can correct; full merge is backlog 5.2. **Cost if wrong:** a follow-up like "make it
   business class" re-searches with default party/dates if she omits them.
2. **"The newest `user` row before the action"** (pre-flight ruling 2) is implemented as "the
   newest hydrated `user` entry in `ctx.state.messages`" — the same scan `lastUserText` already
   uses everywhere — rather than a new DB query, because the action row's `clock_timestamp()`
   already guarantees it sorts after the note's `now()` default. Not a concern once traced; no
   ruling needed.
3. Airline matching and the price-cap regex (`extractPriceMinor`) are small, defensible
   heuristics, not exhaustive ones — a handful of English cap phrasings only ("under", "below",
   "max", "budget of", …). Carried to backlog 5.10 (English-only heuristics).
4. The `filter` branch's fallback-to-driver when Jev says `filter` but there is in fact no results
   row is defensive and untested — could not be constructed without Jev itself misbehaving, since
   `hasResults` is derived from the same lookup the filter then uses.
5. `test/driver.test.ts`/`test/model-client.test.ts` passed at this implementer's snapshot despite
   a warning that a concurrent implementer's in-progress work might break them; the one real
   failure in the full suite traced to someone else's uncommitted `web/data.ts` change, confirmed
   by stashing it.

**Review findings and fixes:**
- Important (1): a `choice` action's `questionId`/`optionId` were not checked against the offered
  `choices` row, so a forged or stale click could be replayed. Fixed in round 1: new
  `readLatestChoices(sql, conversationId, userId)` loaded before any Jev call; a mismatch on
  `questionId` or `optionId` returns a fixed `park` message with zero model/supplier calls and
  zero spend, confirmed by test.
- Important (2): the Haiku front desk's model-calling code was supposed to be deleted per the
  brief but was left in place. Fixed in round 1 — `makeFrontDesk`/`parseFrontVerdict`/
  `FrontDeskDeps` removed, and `frontDesk.ts` no longer calls `loadPrompt('front_desk')` itself.
  **Deviation from the literal instruction, deliberate:** `FRONT_SCHEMA` stays exported (with a
  doc comment explaining why) because `src/monitor/drift.ts` and `test/driver.live.test.ts` — both
  outside this task's file list — still import it to build their own `front_desk` drift canary and
  still load `front_desk.md` themselves; deleting it would have broken both outside this task's
  scope. `front_desk.md` stays on disk for the same reason. `FrontLabel`/`FAQ_ANSWERS`/
  `faqAnswer` are unchanged, and the `front_desk` seat stays declared in `src/model/seats.ts` —
  this is exactly the drift-canary retirement recorded as backlog 5.8.
- Important (3): notebook merge covers origin only — same item as concern 1 above, stays under
  that ruling (backlog 5.2), not refought at the fix round.
- Minor (deferred): filter-with-no-results fallback untested (concern 4); airline/price heuristics
  narrow (concern 3).

Fix round 1/5: 2 addressed, 1 deferred by ruling — choice validated against the stored choices
row; Haiku front desk deleted, `FRONT_SCHEMA` kept for the drift canary; commit `0b2dd6a`; 1119
passed. No re-review (findings were Important, not Critical).

---

## Task 7 — choose: proposals, hotels, the pinned summary

**Status:** complete (commit `89e9930`; 1154 passed). Review folded into the final whole-branch
review by the pace ruling, with its own risks named there (C4, M1, M7).

**Deviations (from the implementer's own report):**
1. **Side-trip hotel search skipped.** The brief: "a side-trip second hotel search only when the
   brief recorded a side trip AND a fixed commitment… if neither carries the side trip, skip it
   and say so." Checked both: `TripBrief.sideTrip` is computed by `assembleBrief` and then
   discarded — `writeBrief` never writes it to the notebook — and `fixed_commitment` is answered
   by Jev but never read by `assembleBrief` at all, reaching no `TripBrief` field. Neither the
   notebook nor any `results`/`choices` row carries a side trip or a fixed commitment anywhere in
   the codebase, so there is nothing to key a second search on. Documented in `choose.ts`'s own doc
   comment; carried to backlog (persisting `sideTrip`).
2. **Read helpers instead of `insertChosen`.** The brief's file list named the addition
   `insertChosen`, but nothing in the Interfaces/Produces section calls for an insert helper
   (`saveProposal` already inserts); the brief's own prose describes two read helpers instead —
   `loadNewestProposalForTurn` (turn-scoped, used to tell "saved" from "rejected": a gate rejection
   or an over-the-round-bound reviewer "Revise:" verdict both save no row, so a `null` read is
   exactly "rejected") and `loadNewestAcceptedItinerary` (conversation-scoped, recovers the flight
   when she later chooses a hotel). Built the two the prose actually needed.
3. **`parentProposalId: null` for both the flight-only and the combined proposal** — never a
   lineage pointer to the prior one. The brief did not specify; matches how `propose_itinerary` (a
   fresh build) always passes `null`, reserving `parentProposalId` for `revise_component`'s own
   edit-in-place lineage.

These deviations were accepted as-is at the time; deviation 1 (side trips) is the backlog item
named below, and deviation 2/3 were judgment calls, not findings, so no ruling fixed them.

---

## Task 8 — the driver steps back

**Status:** `DONE_WITH_CONCERNS` (commit `44dfe36` + fix round `19f8c29`; 1051 passed). Also
touched `src/pricing.ts` and `src/model/cache.ts` (Sonnet 5 entries) and `src/monitor/drift.ts`
(renders the driver prompt placeholder) — outside the brief's literal file list but required by
the seat change itself.

**Review findings and fixes:**
- Critical: Sonnet 5 priced at $3/$15 — the controller's own brief had given that figure, but
  `docs/backlog-plan.md`'s "API drift" section records $2/$10. **Ruling: pricing source of truth is
  `docs/backlog-plan.md`'s "API drift" section until a pricing fetch exists; the controller's
  $3/$15 was a guess and is withdrawn.** **Cost if wrong:** driver spend recorded at the wrong
  rate. Fixed in round 1: $2/$10.
- Important: the cache-write minimum was set to 512 tokens; should be 1,024 (verified against the
  Anthropic docs, 2026-10-03). Fixed in round 1.
- Minor: a stale `ask_user` mention survived in a `worker.ts` doc comment, left over from before
  `offer_choices` replaced it. Fixed in round 1.

Fix round 1/5: 3 addressed, 0 open — $2/$10, 1,024-token cache minimum, the stale `worker.ts`
comment; commit `19f8c29`; controller verified the two constants directly. No re-review per the
pace ruling (findings were factual constants, not design).

**This is the seat the final review's C1 later reverted** (below) — the price and cache-minimum
fix here were correct and are kept; the model choice itself (Sonnet 5 as the driver) was not.

---

## Task 9 — web data and the results components

**Status:** complete (commit `8904a41`; ~1120 passed; build green). Spot-checked per the pace
ruling, not independently reviewed — this is where I3 (stops) and part of M4 originated unreviewed
until the final pass.

**Deviations (from the implementer's own report):**
1. `LegLite` gained a `via: string[]` field not spelled out in the brief's `ResultItemLite` sketch
   — needed for wording like "1 stop, DOH"; derived from `LegSummary.route` (`route.slice(1, -1)`).
2. `priceSteps`/`priceRange` ended up living in `web/filters.ts` rather than `FilterChips.tsx`, for
   cohesion with `test/web-filters.test.ts`; `FilterChips` imports them.
3. **`flight.stops` in `ResultItemLite` is read from the outbound leg only** (the type has one
   `stops` field, not one per leg) — the inbound leg's own stop count is not separately surfaced.
   Noted, not tested against a round-trip-with-different-stops fixture. **This is exactly what the
   final review's I3 found and the fix wave closed** (item 8 below): the chip filter and the typed
   filter judged stops differently because of this.

**Deferred at the time (ledger):** `web/filters.ts`'s departure windows had to match
`src/intake/filter.ts`'s — Task 10 reconciled the windows but, per deviation 3 above, not the
per-leg stops question, which is why I3 was still open at the final review.

---

## Task 10 — the split shell, mobile tabs, optimistic send

**Status:** complete (commit `ff1087d`; 1153 passed; build green). Spot-checked per the pace
ruling, not independently reviewed.

**LOAD-BEARING deferred for the final fix wave, flagged by the implementer at the time:**
`ThreadView` never passes `conversationId` to `MessageBubble`, so `ChoiceCardLive` cannot POST —
choice cards render but are inert in production, for both intake's cards and the driver's
`offer_choices` cards. Pre-existing before this task, not introduced by it, and explicitly called
out as a gap rather than silently shipped. Closed in the final fix wave, item 5.

Also noted: `ResultsPaneLive` posts to `/api/conversations/[id]/choose`, a route Task 7 lands
(concurrent in the same worktree) — the 404 this produces before Task 7's commit lands falls
through `errorForStatus`'s default branch to generic copy, by design, not a bug.

---

## Final whole-branch review — C1–C4, I1–I5, minors

Run at `89e9930` (base `fdd7ae3`, 15 commits, 89 files, +11021/−426) against the code and
`review-fdd7ae3..89e9930.diff`, not the task reports — no `LIVE_*` suite, nothing committed, no
subagents. Result: 1154 passed / 14 skipped, typecheck/lint/build all green. **Verdict: needs a
fix wave.**

### C1 — the driver's Sonnet 5 seat cannot carry the operator channel, in full

`src/model/seats.ts`'s `driver: seat(SONNET, 'medium', 4_000, 'driver@4')` (Task 8's change)
collided with `src/model/client.ts`'s `normalizeOperatorTurns`, which merges every operator note
into a `{ role: 'system' }` entry **inside** `messages[]` — a mid-conversation system message, not
a top-level `system` prompt.

**Mid-conversation `role: "system"` messages are supported on Opus 5, Opus 4.8, Fable and Mythos,
but NOT on `claude-sonnet-5`**, per Anthropic's prompt-caching reference (the model config and the
docs pages conflict on this point; the reference says to treat it as unsupported and catch the
resulting 400). Under plan 5 the operator channel is live on *every* planning turn: a `results`,
`choices` or `action` row hydrates to exactly that kind of `system` message (`src/worker.ts`), so
the driver is only ever reached in production with at least one such message already in the
transcript — `question`/`chat` routes, the hand-off, rejections, revisions, escalation. Nothing in
the branch caught that 400 or fell back; the turn would die in `runTurn`'s catch as a generic
failure. Invisible to the test suite because every driver test uses a stub transport, never the
real API.

*Failure scenario named in the review:* she types "what's the weather like in Tokyo in November?"
after the first results row → router classifies `question` → driver call 400s → turn fails with a
generic message. Same for "Get booking links" once C4 (below) is fixed.

**Ruling: the driver seat reverts to Opus 5, effort medium, 4k thinking, prompt version `driver@4`
unchanged.** Sonnet 5.5 would also carry the channel, but its price is not in this repo's pricing
source (`docs/backlog-plan.md`'s "API drift" section), so it is backlog, not this fix. **Cost if
wrong:** driver turns cost Opus rates; they are off the first-turn critical path (intake/rerank/
router are all Jev, zero generative-model calls), so this only affects `question`/`chat`/hand-off/
escalation turns.

Settled with a one-line seat change plus a wide set of re-derived price pins (`test/driver.test.ts`,
`test/reservation.test.ts`, `test/model-cache.test.ts`, `test/model-seats.test.ts`,
`test/driver.live.test.ts`), all from Opus 5's $5/$25. One side effect the brief did not
anticipate, recorded for anyone touching these fixtures again: `test/model-client.test.ts` has a
byte-count fixture whose whole purpose is that `bytes / 3` be genuinely fractional, so `Math.ceil`
and `Math.floor` disagree; `claude-opus-5` is two bytes shorter than `claude-sonnet-5`, which moved
a 221-byte fixture to 219 — and 219/3 is exactly 73, which would have silently cost that test the
one property it exists to check. The fixture's system string gained one character so the division
stays fractional (220/3 = 73.33…), and the comment in the test says why.

Sonnet 5's `src/pricing.ts` ($2/$10) and `src/model/cache.ts` (1,024-token minimum) entries are
kept, with a comment explaining that Sonnet 5 is not the driver for a channel-support reason, not a
price reason, and that Sonnet 5.5 is the future candidate once its price is recorded.

**Still outstanding (backlog): `LIVE_MODEL=1` has not probed the operator channel on Opus 5.** No
Anthropic credit was available to run it; the fix restores the *designed* transcript shape but does
not prove the model's behaviour on it. See backlog row 5.12 below.

### C4 — spec §9 wins: Choose is not acceptance for the combined proposal

**The conflict:** spec §9's ruling says "Choose is acceptance; 'Get booking links' is the
hand-off" — flatly, with no carve-out. Plan Task 9 Step 2 wires the "Get booking links" button to
`POST /api/proposals/[id]/decide { decision: 'accept' }`, **only** when `proposal.decision` is
null. Task 7's own `handleChoose` calls `decideProposal(..., 'accept')` on BOTH the flight-only
proposal and the combined flight+hotel proposal, immediately, inside `handleChoose` itself — so by
the time she would press "Get booking links" on the combined proposal, `decision` is already
`'accept'`, the button renders only while `decision === null` (`PinnedSummary.tsx`), and
`ResultsPaneLive.onGetLinks` early-returns on a non-null decision; `POST /decide` would throw
`decideProposal: ... already decided` anyway. The result: "Get booking links" could never be
pressed on the exact proposal it exists for, and the cashier, the price re-check and the tracked
links were dead code for the whole plan-5 flow.

**Ruling: spec §9 wins. Choose on the hotel does NOT accept the combined proposal** — it stays
undecided so "Get booking links" (`decide` → `hand_off` action → driver → cashier) is the
acceptance, exactly as spec §9 says. **The flights-only proposal stays accepted** on Choose
(flight) — `loadNewestAcceptedItinerary` depends on that to recover the chosen flight when she
later chooses a hotel, so only the *second*, combined accept call is the one removed. **Cost if
wrong:** one extra click (the ruling the final review itself flagged as the cost before the fix
landed — which this records for completeness even though the fix wave then closed it).

Fixed by dropping the `decideProposal` call from `handleChooseHotel` (kept in
`handleChooseFlight`); the reply text for a combined proposal became 'Trip summary ready. Use
"Get booking links" when you want to book.' A new test asserts both decisions — flight accepted,
combined undecided — in one place so they cannot drift apart again. (Still gated on C1 for the
driver call that follows a click on "Get booking links": the `hand_off` action reaches the driver,
and the driver must be reachable with the operator channel intact.)

### C2 — a choice card with zero or one options

A choice card built from `placeOptions`/`dateOptions` could legitimately return `[]` or a single
entry (e.g. "I want to go somewhere warm next month, just me" → no place candidates → `origin`
answer `none` → `{ kind: 'choices', questionId: 'origin', options: [] }`), and
`ChoicesContentSchema` was `.min(1)`, so `buildAttachmentRows`'s `.parse` threw and failed the
whole turn — exactly the case spec §9's own ruling promised would "become a choice card, never a
wrong search." Fixed by having `placeOptions`/`dateOptions` each top up to at least 2 options from
a cascade of fallback sources (Jev's ranking → her last origin → the code-found candidate list →
`busiestFor`'s fixed four, anchored on the place already known and falling back to a documented
European default), capped at 4, with `ChoicesContentSchema.options` tightened to `.min(2).max(4)` —
spec §3's stated range, now enforced by the schema rather than by convention. **Broader than the
review's own smallest-fix wording, necessarily:** the review named only `placeOptions`; the date
card (`dateOptions`) had the identical hole and tightening the schema without fixing both would
have moved the throw rather than removed it.

### I4 — origin never equals destination; origin card never offers the destination

The origin card ranked probabilities over the same place-candidate list used for every place
question, stripping only `none`/`unstated`, so a message with no stated origin and no stored last
origin could offer the destination itself as the only origin option — clicking it set
`origin = destination` with no equality guard (unlike `sideTrip`, which already had one), running a
same-city search. Fixed alongside C2: `placeOptions` takes the other end of the flight as an
`exclude` argument, and `assembleBrief` refuses `origin === destination` outright (falling through
to the origin card instead of a nonsense search), applied to the stored last-origin fallback too.

### C3 — a clicked choice card re-ran intake on the clicked label, not her original message

`src/handler.ts`'s `submitAction` writes a `userNote` row (`role='user'`, the clicked label, e.g.
"Barcelona") immediately before the `choice` action row, and hydration puts the newest `user` row
last in the transcript — which `src/agents/router.ts`'s `choice` arm then read as "her message" and
re-ran intake on. In production `ChoiceCardLive` always sends `text: label` per spec §3, so the
note row always exists, and the router test that claimed to cover this hand-built a transcript with
only the original message and never inserted the note row — asserting a shape production never
produces. **Failure scenario:** "a week somewhere, flying from where I usually do" → origin card →
she clicks "Barcelona" → intake re-runs on the text "Barcelona" with `overrides.origin = 'BCN'` →
destination and dates are now absent from that re-run → another choice card, or a nonsense brief —
her original trip request is lost and the loop can repeat. Fixed with
`readNewestUserTextBefore(sql, conversationId, userId, before)`, reading the newest `user` row
strictly before the `choices` row's own timestamp rather than the newest `user` row in the whole
transcript, with an added rule that skips a `user` row whose next row is an `action` (the
click-note signature) so a chained card (origin → click → destination → click) re-runs on her
original request and not on the first click's label either.

**Not fixed, and recorded as a known limit rather than a regression:** `overrides` still carries
only the clicked `questionId` at a time, so a chained card forgets the earlier click's answer. This
is pre-flight ruling 2 as written, not new; the notebook-merge backlog item (Task 6's concern 1,
above) is where a real fix belongs.

### Important findings, their mechanism, and the fix

- **I1 — typed filters compound destructively and cannot be widened.** `router.ts` read the
  *newest* `results` row — which, after one typed filter, is itself the filtered row — and applied
  the next filter on top of that, so no typed message could ever widen the set again ("show me all
  flights" returned the same narrowed list). Fixed by reading the newest *unfiltered* row of that
  kind and query as the corpus for every typed filter (a new `readLatestUnfilteredResults`), so
  filters apply as chips over the stored results the way spec §2.2 describes, not over each other.
  Also closed an unrecorded deviation found at the same time: `Filter.maxStops` was unreachable
  from typed text (only chips could set it) — `routeMessage` gained a `one_stop_ok` Noul question
  feeding `maxStops: 1`, kept separate from `nonstop` so the two can disagree without
  `describeFilter` printing both.
- **I2 — the reviewer's spend was dropped from the turn total on a throw after `reviewOffer`.**
  `handleChoose` called `runProposalPath` outside any `try`; a throw inside `saveProposal` (after
  the reviewer's cost had already accumulated on `spent.micros`) propagated to `runTurn`'s catch,
  which never saw it — exactly the F4 bug the driver's own tool path had already fixed with a
  `finally`, with no equivalent on the `choose` path. Fixed by wrapping both `runProposalPath`
  calls, returning a `fail` arm with `recordedMicros: spent.micros` on a throw.
- **I3 — the chip filter and the typed filter disagreed on stops.** `web/data.ts`'s `flightLite`
  set `stops` from the outbound leg only (Task 9's own flagged deviation, above); the chip and the
  typed filter judged `nonstop`/`maxStops` on that single number, while `src/intake/filter.ts`
  required every leg — she could click "Nonstop" and get a flight whose *return* leg had two
  stops, then type "only direct flights" and have it removed. Same ids, two answers. Fixed by
  carrying `inboundStops` alongside `stops` on `ResultItemLite.flight` and comparing the worse leg
  (`worstLegStops`) in both filter modules, with a doc comment on each saying they must be changed
  together.
- **I5 — the router's Jev cost was silently undebited on a replayed tool step.** `withExtraCost`
  folded the router's own Jev cost into `step.costMicros`, but the worker's `tool` case only calls
  `recordSpend(step.costMicros)` on the *fresh* branch — a `replayed` resume skips it, so a
  genuinely new Jev call made during a resumed turn never reached `conversations.spend_usd_micros`.
  Fixed by treating a `tool` step like the `fail` arm (debit by hand, report on `recordedMicros`,
  which the worker already folds into the turn total on every path). **The review's stated
  mechanism was corrected during the fix, not just applied:** the review described
  `recordedMicros` as something that needed adding to the worker; in fact the worker already folded
  it in on every path, so the fix needed only the router-side change, verified by removing it and
  watching the new test fail.

### Minor findings, their fix, and what stayed deferred

| Finding | Fix |
|---|---|
| M1 — zero hotels still said "Here are hotels" and attached an empty results row | Own reply: "I could not find hotels in {place} for those dates. Tell me a different area or dates." No attachment, still a `park` (the flight proposal stays accepted and durable). |
| M2 — conversation titles never written since the Haiku front desk's retirement | `setTitle(sql, { conversationId, userId, title })`, code-built from the brief (`tripTitle`), written beside `writeBrief`/`setDesk` once search+rerank succeed; overwrites rather than coalesces, since a `new_search` trip supersedes the old title. |
| M3 — `loadChosen`/`loadChoices` had no caller outside their own tests | Removed, with their tests and the now-unused `parseChoices` import/`ChoicesView` type. |
| M4 — `ResultsPane` ignored `ResultsView.filter`, chips rendered unselected after a typed filter | Chip state derived from the row's own filter, keyed to the row's `messageId` and reset during render (not a `useState` initializer alone, which would not survive `router.refresh()` re-rendering the same instance). |
| M5 — `Filter.airlines` capped entries at 8 characters, an IATA-shaped guess that could fail `ResultsContentSchema.parse` on a longer supplier carrier string | `.max(64)` with `maskUntrustedText` applied in the schema — this is supplier-authored text and the schema is the trust boundary, same as every other supplier-origin string in the file. |
| M7 — the rejection message said "price moved or expired" even for a reviewer `Revise:` verdict with rounds left | Two fixed sentences, picked by reading only the `Revise:` prefix `runProposalPath` itself writes, never the reviewer's or gate's own prose. |
| M6 — `askJev`'s 3 s timeout with one retry means the first turn's two Jev calls alone can take ~12.6 s worst case, eating spec §6's "< 10 s first results" headroom | **Not fixed. Backlog 5.x.** |
| M8 — `loadNewestAcceptedItinerary`/`loadNewestProposalForTurn` are not `user_id`-scoped | **Not fixed. Backlog 5.x.** Consistent with the existing `loadProposal` pattern and the ids come from an ownership-checked `ctx`, so this is a style note, not an exposure. |
| The known LOAD-BEARING gap: `ThreadView` never passed `conversationId` to `MessageBubble` | Optional `conversationId?: string` added to `ThreadViewProps`, forwarded to `MessageBubble`; kept as a prop (not read from `conversation.id` inside `ThreadView`) so the existing pure `renderToStaticMarkup` cases do not start mounting `ChoiceCardLive`, which calls `useRouter()`. |

### Unrecorded deviations found at the final review, now recorded

1. **`recordSpend` gained a third call site.** The pre-flight ledger recorded "Jev cost returned as
   `costMicros` (undebited) → worker `recordSpend`s once"; `router.ts`'s `withExtraCost` now debits
   by hand on the `fail` arm too — correct accounting, but a new money-moving site with no ruling
   behind it, and it had the I5 replay hole until the fix wave closed it.
2. **Spec §3's "2 to 4 options" was not enforced** — `ChoicesContentSchema` was `.min(1)`, and
   `placeOptions`/`dateOptions` could produce 0 or 1 (C2, I4). No ruling had relaxed the range; now
   enforced by the schema (`.min(2).max(4)`), closed in the same fix.
3. **Who accepts the proposal** was a live spec/plan disagreement: spec §9 ("Choose is acceptance")
   vs. plan Task 9 Step 2 ("wired to `/decide` only when `proposal.decision` is null"). The branch
   had implemented both halves, and the hand-off fell through the gap between them (C4). Resolved
   by the C4 ruling above: spec §9 wins for the combined proposal.
4. **Front-desk retirement dropped title and label writing** as a side effect nobody had named —
   `routeToPlanning`/`recordFrontLabel` lost their only production caller, and `setDesk` deliberately
   never touches `title`, so no conversation had been titled since. Fixed via M2 above.
5. **`Filter.maxStops` was unreachable from a typed message** — only chips could ever set it, so
   spec §2.2's typed "up to 1 stop" silently resolved to plain `nonstop` or nothing. Fixed in I1's
   commit (`one_stop_ok`).
6. **`web/filters.ts` vs `src/intake/filter.ts` disagreeing on stops (I3)** had been deferred at
   Task 9/10 as "the departure windows are reconciled, the stops question is not" — recorded as
   deferred but shipped unresolved until this wave closed it.
7. **Not a deviation, a confirmation:** Sonnet 5 at $2/$10 and the 1,024-token cache minimum (Task
   8's own fix round) are both correct against the Anthropic docs reference, as are Opus 5's $5/$25
   and 512-token minimum. The Task 8 review's withdrawn $3/$15 guess was right to withdraw.

### The fix wave

12 commits (`89e9930..85afcc4`), one per finding, in dispatch order: `e3221af` (C1), `f02d623`
(C2, I4), `9843164` (C3), `b6c90f3` (C4), `f443fad` (the Task 10 gap), `3ce04b2` (I1, deviation 5),
`15ef7e3` (I2), `9941d4f` (I3, M4), `a69cc77` (I5), `21841c8` (M1, M7), `fe4e930` (M2), `85afcc4`
(M3, M5). No subagents, no `LIVE_*` suite, no `pnpm demo`, nothing pushed, no env values printed.
Baseline at `89e9930` was 1154 passed / 14 skipped; the wave ends at **1181 passed / 14 skipped**
(+27 tests, same file count), typecheck/lint/build all green throughout (gates run after every
item). No scoped re-review was requested afterward.

Not in this wave, carried to backlog explicitly: M6 (Jev timeout headroom), M8 (proposal readers
not `user_id`-scoped), Sonnet 5.5 as the driver, the `new_search` notebook merge beyond origin,
side-trip hotels, currency from origin. Also left as-is: `overrides` carrying only one `questionId`
at a time (C3's note above).

---

## Additional finding during the records pass (Task 11), not in the final review

`.env.example` does not list `JEV_KEY`, although `docs/deploy.md` §3 states "every name in
`.env.example` must exist on the site" and the harness (`src/env.ts`) reads `JEV_KEY` through
`loadOptionalEnv` exactly like `GOOGLE_SEARCH_API`, which IS listed. `docs/deploy.md` §3 is
corrected in this pass to add `JEV_KEY` to the secrets loop directly (see that file); `.env.example`
itself is left untouched, as it is outside this task's four permitted files — recorded here so it
is not lost, and filed as backlog row 5.17.

---

## Parked

Real, none load-bearing to plan 5's own scope, filed to backlog rather than fixed here. See
`docs/backlog-plan.md`'s "Plan 5 — carried debt" table for the full numbered list (rows 5.1–5.17),
which includes every item named above as "backlog" plus items named only in the plan's own Task 11
brief (side trips beyond one, children/infants in the brief, the 300-entry place-table cutoff,
hotel re-rank, Jev self-consistency for low-confidence fields) and the `front_desk` seat's
drift-canary-only retirement.

**Unrun:** the `LIVE_MODEL=1` probe of the operator channel on Opus 5 (C1's own caveat) — blocked
on Anthropic account credit (carried from backlog 3c.17 / 4a.14). **Also unrun** (outside this
task's scope, named in the plan's own Task 11 Step 1/2, not executed in this docs-only pass):
the live Netlify smoke of the Tokyo message end to end, and confirming `JEV_KEY` is present in
`netlify env:list --context production`.
