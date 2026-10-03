# Plan 5 — Results first: Jev intake, flight and hotel lists, the Kayak split

**Date:** 2026-10-03
**Status:** Approved for planning
**Parent spec:** `2026-08-15-globetrotty-design.md` (binding). This plan replaces the first turn
of every conversation and the shape of what she sees, and narrows the driver's role. Where the two
disagree on money, trust boundaries or gates, the parent wins and this document is wrong.
**Scope:** the first reply is a list of real flights, not a question; hotels follow the chosen
flight; filtering is instant; genuine uncertainty becomes 2 to 4 clickable options, never a
free-text question; the window splits chat / results once results exist. **Out (plan 5b):**
multi-city itineraries beyond one side trip, activities, streaming, memory across trips.

---

## 0. What the data says (the conversation of 2026-10-03 16:35)

- One turn, 33 s, no search: Haiku front desk 2.6 s, Opus driver (effort high, 16k thinking)
  15.2 s, then the notebook **refused the whole patch** (the model used key names the tool never
  listed), then a second Opus step of 4.1 s that asked three questions.
- The three questions were caused by us: no "today" in any prompt (so the year was ambiguous),
  and `driver.md` naming budget as a fact that blocks planning.
- The gates already accept a flights-only proposal (`checkSlots` validates names, not
  completeness). Kiwi already takes `cabinClass` and `max_sector_stopovers`; the tool schema never
  exposed them.
- Jev (`api.typesafe.ai/v1/systemone`, model `jev-latest`) answers Choice / Score / Noul
  questions in 70 to 500 ms with calibrated confidence; many questions in one call cost one
  round trip. It cannot generate text or extract free values: it chooses among candidates we
  give it. The key is `JEV_KEY` in `.env.local` and on Netlify.

## 1. The first turn

### 1.1 Intake: candidates by code, decisions by Jev

`src/intake/candidates.ts` finds, in her message:

- **places**: tokens matched against a bundled IATA city/airport table (`src/intake/places.json`,
  metro codes such as `TYO`, `BCN`, with common misspellings and local names: "tokio", "kioto",
  "barcelone"); each candidate carries the matched span.
- **date parts**: day numbers with ordinal suffixes, month names and numbers, four-digit years,
  weekday names, relative words ("next", "tomorrow").
- **counts**: small integers and words ("two of us", "my wife" implies 2).

`src/intake/brief.ts` sends ONE Jev call (speculative fan-out) with the message plus the
candidate lists as structured `state`, and these questions, each with an explicit
`unstated` / `none` option:

| key | type | options |
|---|---|---|
| origin, destination, side_trip | choice | the place candidates + none |
| outbound_month, return_month | choice | January..December + unstated |
| outbound_day, return_day | choice | 1..31 + unstated |
| outbound_year, return_year | choice | current year, next year, unstated |
| outbound_relative | choice | none / tomorrow / weekday / next-week pattern (cookbook) |
| party_adults | choice | 1..6 + unstated |
| trip_type | choice | return / one_way / unstated |
| cabin_long, cabin_short | choice | economy / premium_economy / business / first / unstated |
| max_stops | choice | nonstop_only / one_stop_ok / unstated |
| hotels_wanted | noul | she wants accommodation handled too |
| arrive_by_date | noul | the outbound date is an arrival deadline, not a departure day |
| fixed_commitment | noul | a dated must-be-there event is named |

Code assembles a `TripBrief` (zod): resolved ISO dates (nearest future occurrence from today;
"arrive by" subtracts one day for journeys the place table marks long-haul), party, cabins,
stops, places as metro codes, `assumptions: Assumption[]` (one per field Jev marked unstated or
code defaulted: `party 1`, `economy`, `return`, `any stops`, `year 2026`). Jev never does
calendar arithmetic; `src/intake/dates.ts` does, with tests.

### 1.2 Gates on confidence

Per field: `confidence >= 0.6` is accepted; below that, the field's top three probabilities become
a **choice card** (§3) and nothing else happens this turn. Only `destination` and `outbound`
dates are required for a flight search; `origin` falls back to the account's last used origin,
else a choice card. A `return` trip with no return date gets a 7-night default, listed as an
assumption.

### 1.3 Search and list

With a complete brief, code calls the flight supplier directly (no model): `from`, `to`,
`departureDate`, `returnDate`, `adults`, `cabinClass`, `maxStops`. Results go to `tool_results`
exactly as the tool door writes them today (same corpus, same ids, same TTL). A second Jev call
re-ranks the top 20 by a Score against the stated preferences (cabin honoured, stops, departure
window, total duration) and the list shows the best 10. The reply is one `messages` row of
`role='agent'` with fixed, code-written text ("Here are flights for 2 adults, Barcelona to
Tokyo, 19 Nov to 6 Dec, premium economy. I assumed … ") plus a `results` row (§2.3).

### 1.4 Budget

Intake and re-rank are code-door spend recorded through `recordModelCall` with seat `intake`
and `rerank` at Jev's input price; the supplier search uses the existing per-turn supplier
budget and `reserve → reconcile`. Nothing new moves money.

## 2. Results, filters, hotels

### 2.1 Flight list

A results pane item shows price, airline(s), outbound and inbound times, stops, duration, bags,
self-transfer flag, fetched age, and a **Choose** button. Choose is a card action on the
operator channel (`ActionPayload` gains `choose_flight { sourceId }`), never user text.

### 2.2 Filters

Chips above the list: nonstop, up to 1 stop, departure window (morning / afternoon / evening),
max price, airline. They filter client-side over the stored results, no turn. A typed message
goes through **Jev intent routing** (one Noul/Choice call): `filter` (apply as chips, reply with
one fixed line), `new_search` (brief changes: dates, places, party, cabin: re-run §1), `question`
or `chat` (the driver, §4), `faq` (fixed answers, as today). The routing call replaces the
Haiku front desk.

### 2.3 Rows

`messages.role` gains `results`; `content` is JSON `{ kind: 'flights' | 'hotels', query,
sourceIds: string[], assumptions }`. Hydration into the model transcript renders it as a short
system note ("the office showed her 10 flights for …"), ids only. The web layer renders it from
`tool_results` through the existing `loadAlternatives`-style reads.

### 2.4 Hotels after the flight

`choose_flight` records the choice (`proposals` row with the flight slot(s) only,
`decision='accept'`, gates run), then code searches hotels for the destination between the
chosen dates (and the side trip for its own window when `fixed_commitment` placed it) and
appends a `results` row of kind `hotels`. Choose on a hotel records a second proposal
(`stay`), gates and the reviewer run on the combination, and the pinned summary gets "Get
booking links" (today's hand-off: price re-check, tracked links).

## 3. The choice card

A `messages.role = 'choices'` row: `{ question, options: [{ id, label }] }` (2 to 4). Rendered
as buttons in the chat. A click posts the option **label** as an ordinary user message; the
option id travels alongside as `choice { questionId, optionId }` on the operator channel so code
can resolve it without re-parsing. Two writers: intake (§1.2) and the driver's new
`offer_choices` tool, which replaces `ask_user`. Labels written by the driver pass
`maskControlChars` before they are stored.

## 4. The desk model

- The driver runs on **Sonnet 5, effort medium, 4k thinking**; Opus stays available as a config
  switch, not the default. It is invoked only for `question` / `chat` routes, the hand-off and
  escalation. The user-visible status for those turns stays "Thinking".
- `driver.md`: today's date and the notebook's allowed keys are injected (dated line in the
  notebook suffix, so the cached prefix is untouched); "When to ask" becomes "Never ask in free
  text; call `offer_choices` only when you cannot proceed, 2 to 4 options; never ask for a
  budget"; the flights-first flow is described.
- `update_requirements` publishes its key list in the tool description.

## 5. The split

- Before any `results` row: the landing / plain thread as today.
- After: the rail collapses to a 56 px strip (wordmark mark, New trip, expand); the chat column
  is 25% (min 320 px) with the thread and composer; the results pane is the rest, with the
  filter chips, the pinned chosen items at the top, and the lists below. The pane is a client
  component fed by the page (RLS reads) and refreshed by the same Realtime subscription.
- Phones: a two-tab layout, Chat and Results, with a badge when new results land.

## 6. Speed budget

| Step | Target |
|---|---|
| Intake (candidates + one Jev call) | ≤ 1.5 s |
| Flight search (supplier) | 3 to 8 s |
| Re-rank + render | ≤ 1 s |
| **First results** | **< 10 s** |
| Typed filter | < 1 s, no search |
| Hotels after Choose | 3 to 6 s |

## 7. Security and trust

- Jev sees her message and supplier result summaries; both are already data we hold. Its
  answers are option ids from lists we wrote, so nothing it returns is rendered as text.
- `results` and `choices` rows carry ids and enum values only; labels written by the driver are
  masked; the client renders every string as plain text as today.
- `choose_flight` and `choice` are zod `strictObject`s on the operator channel; the routes check
  ownership on the owner connection exactly like `decide`.
- The sentinel test gains `JEV_KEY` to the list of names that must never appear under `app/` or
  `web/`.

## 8. Tests

- `src/intake/*`: candidates (fuzzy places, date parts, counts), brief assembly and date
  arithmetic against recorded Jev responses (fixtures), confidence gating.
- One live Jev test gated `LIVE_JEV=1`: the Tokyo message of §0 yields the expected brief.
- Re-rank and intent routing against fixtures; the filter reducer.
- Operator channel: `choose_flight` and `choice` parse, render and refuse user text.
- Render tests for the flight list, hotel list, choice card and the split shell; the money
  and gate suites unchanged.

## 9. Rulings

- Opus leaves the critical path; the first turn has no generative model. Cost if wrong: a
  message the candidate finder cannot read becomes a choice card, never a wrong search.
- Budget is never asked; price is a filter after results.
- "Arrive by" dates move the departure a day earlier for long-haul and say so.
- Choose is acceptance; "Get booking links" is the hand-off. No separate accept step.

## 10. Corrections after build (2026-10-03)

Found and fixed during the whole-branch final review and its fix wave
(`docs/superpowers/2026-10-03-plan-5-results-first-decisions.md` has the full findings and
rulings); each line below is a correction to the text above, not a new requirement.

- **§4 — the driver runs on Opus 5, effort medium, 4k thinking, not Sonnet 5.** This document's
  original text named "Sonnet 5, effort medium, 4k thinking" as the default, with Opus "available
  as a config switch." Built as written, then reverted at the final review's C1: Sonnet 5 cannot
  carry a mid-conversation `role: "system"` message, and this product's operator channel
  (`normalizeOperatorTurns`, src/model/client.ts) puts one in the transcript on every planning
  turn that reaches the driver at all (a `results`, `choices` or `action` row hydrates to exactly
  that shape). Opus 5, Opus 4.8, Fable and Mythos all support it; Sonnet 5 does not (Anthropic's
  prompt-caching reference). The driver is therefore Opus 5 at effort medium, 4k thinking, prompt
  version `driver@4`, unchanged from before this plan. Sonnet 5.5 does carry the channel and is
  the candidate for a future switch, once its price is recorded in this repo's pricing source
  (`docs/backlog-plan.md`'s "API drift" section) — see backlog 5.1. The `LIVE_MODEL=1` probe of
  the operator channel on Opus 5 has not been run (no Anthropic credit); the fix restores the
  designed transcript shape, it does not yet prove the model's behaviour on it.

- **§2.4 — the combined flight+hotel proposal is accepted by "Get booking links", not by
  Choose.** §2.4's text as written has Choose on a hotel immediately recording "a second proposal
  (`stay`), gates and the reviewer run on the combination" with no further qualification, which
  reads as acceptance happening at that Choose. As built, that call also ran `decideProposal(...,
  'accept')` on the combined proposal immediately — which made "Get booking links" permanently
  unreachable (the button renders only while `decision === null`), the exact conflict §9's own
  ruling ("Choose is acceptance; 'Get booking links' is the hand-off") was meant to settle and did
  not, because plan Task 9 Step 2 wired the button to accept-when-null while Task 7 built Choose
  to accept unconditionally first. **§9 wins:** Choose on a hotel records the combined proposal
  and runs gates and the reviewer, but leaves `decision` null; "Get booking links" is what accepts
  it (`decide` → `hand_off` action → driver → cashier). The flights-only proposal from Choose
  (flight) is unaffected and still accepts immediately — `loadNewestAcceptedItinerary` depends on
  that to recover the chosen flight for the later hotel search.

- **§1.1 — side trips are detected but not persisted; there are no side-trip hotels yet.** The
  brief's `side_trip` Jev question and `TripBrief.sideTrip` both exist and are assembled
  correctly (including the equality guard against the destination), but `writeBrief` never writes
  `sideTrip` to the notebook, and `fixed_commitment` (also answered by Jev) is never read by
  `assembleBrief` into any `TripBrief` field. Nothing in the notebook or in any `results`/`choices`
  row carries a side trip or a fixed commitment today, so §2.4's "and the side trip for its own
  window when `fixed_commitment` placed it" second hotel search has nothing to key on and is not
  built. Backlog 5.4.

- **§2.2 — the `new_search` notebook merge covers only the origin field.** The text says a
  `new_search` message's brief "merges with the notebook: a field Jev marks unstated keeps the
  notebook value" without naming which fields. As built, only `origin` has this fallback (via a
  `lastOrigin` parameter preferring the notebook's own `originCity` over the cross-conversation
  `readLastOrigin` lookup); destination, dates and party have none, so a `new_search` message that
  leaves any of those unstated gets the same choice-card/default behaviour as a first message, not
  the notebook's existing value. Accepted as a deliberate partial ruling during Task 6 (full merge
  would widen `assembleBrief`'s signature, a larger and more speculative change than that task's
  scope). Backlog 5.2.

- **§3 — "2 to 4 options" is enforced by `ChoicesContentSchema` (`.min(2).max(4)`), with a
  code-side top-up, not merely a convention the two option-building functions were trusted to
  follow.** As originally built, `placeOptions`/`dateOptions` could legitimately return 0 or 1
  option (no code-found candidates, or a single unambiguous one after excluding `none`), and the
  schema was `.min(1)`, so a 0-option card threw inside `buildAttachmentRows` and failed the whole
  turn — exactly the case this document's own §9 ruling says should "become a choice card, never a
  wrong search." Fixed at the final review's C2: both builders top up to at least 2 options from a
  fallback cascade (Jev's own ranking → her last origin → the code-found candidate list →
  `busiestFor`'s fixed four, anchored on the place already known), capped at 4, and the schema now
  enforces the range directly rather than leaving it to caller discipline. The origin card also
  now excludes the already-resolved destination from its own options and `assembleBrief` refuses
  `origin === destination` outright, which this document's §2.1/§1.2 text did not previously rule
  on either way.

- **Conversation titles are code-built from the brief, with no model call.** Not stated anywhere
  in this document; the original design (per the parent spec and plan 4a) had the Haiku front desk
  write `conversations.title`/`front_label`. Retiring the front desk for intake (§1.1, §4) dropped
  that write with no replacement, so no conversation was titled after this plan landed, until the
  final review's M2: `src/agents/intake.ts`'s `tripTitle(brief)` builds a fixed-format title
  ("Barcelona to Tokyo, 19 Nov to 6 Dec", or "Barcelona to Tokyo, 19 Nov" for a one-way) from
  place-table city names and ISO dates only — no model call, nothing of hers in it — written
  alongside `writeBrief`/`setDesk` once a search has actually succeeded, and it overwrites rather
  than preserves an older title on a `new_search`.

- **The `front_desk` seat is retired from production use but stays declared.** This document's
  §4 describes the driver taking over "question/chat routes, the hand-off and escalation," and §2.2
  says the new Jev router "replaces the Haiku front desk" for the first-message triage that used to
  live there — both true, and both leave the seat's actual disposition unstated. In practice:
  `makeFrontDesk`/`parseFrontVerdict`/`FrontDeskDeps` are deleted, and `frontDesk.ts` no longer
  calls `loadPrompt('front_desk')` for production routing. `FRONT_SCHEMA` stays exported (with a
  doc comment explaining why), because `src/monitor/drift.ts` and `test/driver.live.test.ts` still
  use it to run a `front_desk` drift canary independent of whether anything routes through that
  seat in production, and `front_desk.md` stays on disk for the same reason. `FrontLabel`/
  `FAQ_ANSWERS`/`faqAnswer` are unaffected, and `src/model/seats.ts` still declares the seat. See
  backlog 5.8.
