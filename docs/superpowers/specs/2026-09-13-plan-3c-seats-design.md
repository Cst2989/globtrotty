# Plan 3c — The seats half: front desk, scouts, drift monitor, CI

**Date:** 2026-09-13
**Status:** Approved for planning
**Parent spec:** `2026-08-15-globetrotty-design.md` (binding). This document narrows §3, §4, §7, §8
and §11 of the parent to one plan and records the rulings taken to do so. Where the two disagree,
the parent wins and this document is wrong.
**Scope:** everything the work log lists under "What 3c needs", plus backlog 3b.5 and 3b.6. Out:
`check_transfers` (no data source was ever chosen), parallel scouts (the loop answers one tool
call per step), cheap-seat request-shape capture (ruled out below).

---

## 0. Two one-liners from 3b's final review

- **3b.5** — in `src/tools/escalate.ts`, a failed `markNotified` after a successful `notify` must
  not fail the turn: the stamp is best-effort, logged, swallowed. The row and the page already
  happened.
- **3b.6** — in `src/sweeper.ts`, the crash-loop reap writes `conversations.status = 'failed'` only
  when the status is not already `'escalated'`, the same `case` guard `completeTurn` and `failTurn`
  carry since 3b.

Each gets a discriminating test.

## 1. Front desk

**Where it runs.** Inside the durable turn, as an `Agent` the worker calls, never in the sync
route. It is a paid model call: it reserves, reconciles and records like every other seat, and the
10-second route cannot host that. Conversations are created with `desk = 'front'` (migration 0015
changes the column default; existing rows keep `'planning'`). A `routeAgent(deps)` reads
`conversations.desk` at the start of each step and dispatches to `makeFrontDesk` or `makeDriver`.

**The call.** Seat `SEATS.front_desk` (Haiku 4.5, 1 024 tokens, `front_desk@1`), one user turn
carrying her message, structured output:

```ts
{ label: 'new_trip' | 'faq' | 'unclear'; answer: string | null; title: string | null }
```

- `faq` — a question the desk can answer without planning (what we do, how links work, what we
  cannot do). `answer` is required and is the agent message; the turn parks (`awaiting_user`);
  `desk` stays `'front'`.
- `new_trip` — `title` is required: destination, month, party size, per parent §9 ("Portugal"
  three times is not a title). The desk writes `conversations.title` and
  `conversations.desk = 'planning'`, and the **same turn continues into the driver** — the front
  desk returns a `continue` step, and the worker calls the router again. She never waits twice.
- `unclear`, a refusal, a `max_tokens` stop, a parse failure, `faq` with a null answer, or
  `new_trip` with a null title — all route to planning exactly as `new_trip` does, without a
  title. Parent §3: never guesses, never drops.

**What is recorded.** `conversations.front_label` (migration 0015, nullable, check-constrained to
the three labels plus `'fallback'` for the parse-failure route) — parent §7 asks for routing labels
extracted at write time because they outlive the 90-day trace window. `capture_policy` for
`front_desk` is already `'full'`.

**Correction (Task 11):** the front desk masks her answer and the trip title with a new
`maskControlChars` (`src/sanitize.ts`), not `maskUntrustedText`. `maskUntrustedText` caps at 128
characters and masks non-ASCII to `'?'`, which is correct for supplier-origin strings but wrong for
OUR OWN model's prose — a faq answer would truncate mid-sentence and "Málaga" would become
"M?laga". `maskControlChars` strips only control characters and line separators, keeps Unicode
letters, and has no length cap of its own (the title is separately sliced to 120 characters); line
breaks (`\n`, `\r`, `\t`, `U+2028`, `U+2029`) map to a single space rather than `'?'`, since a
line break in legitimate prose (a paragraph break, a pasted tab) should reflow, not read as
corruption — the newline-injection guard this function exists for is about the structure a line
break creates in the model's context, not the character displayed. Every other C0/C1 control
character still becomes `'?'`. The scout's brief (§2) and the driver's expired-results notice (§3)
use related functions for the same reason — see those sections' corrections.

**The titler.** Folding the title into this call leaves the declared `titler` seat unused. It stays
declared (the `model_calls.seat` constraint lists it) and is recorded in the backlog as spare.

**The worker.** `AgentStep` gains `{ kind: 'continue' }`: no message, no tool, costMicros 0, the
agent already debited its own call via `recordedMicros`. `loop()` treats it as "call the agent
again" without appending anything to the transcript. The step counter still advances.

**Ceiling.** The front desk's reservation is checked against the ceilings exactly as the driver's;
a ceiling reached before the call fails the turn `limit_reached` with the driver's wording.

## 2. Scouts — `research_destination`

**Shape.** A worker-door tool in `DESK_TOOLS.planning`, schema `{ city: string (1..80) }`. The
handler runs one Haiku call on `SEATS.scout` (2 048 tokens, `scout@1`) with a system prompt that
asks for a brief of at most 300 words on the city as a destination for her party — neighbourhoods,
seasons, transport from the airport, what to avoid — and **never a price, a fare, or a rate**. The
only tool offered is the API's server-side web search, `{ type: 'web_search_20260209', name:
'web_search', max_uses: 3 }`. No other tool, no outbound channel, no memory write.

**Words never prices, enforced by code.** The brief passes `redactPrices(text)` before it returns:
a deterministic filter that replaces currency-shaped tokens (a currency symbol or ISO code adjacent
to a number, a number followed by `per night|pp|per person`, a postfix currency symbol, a numeric
range, a spelled-out currency word, or a k-suffix) with `[price removed]`. This is the same filter
parent §9 requires on the streamed prose channel in plan 4; it is built here, in `src/sanitize.ts`,
with its own table of cases. A brief over 300 words is cut at the last sentence boundary under the
cap and told so.

**Correction (Task 11):** the tool type is `web_search_20250305` — the API's basic web-search
variant — not `web_search_20260209`. Haiku 4.5 (the scout's seat) returns a 400 on
`web_search_20260209` ("does not support programmatic tool calling"): that variant adds dynamic
result filtering, which runs code execution under the hood, and is supported only on Opus 4.6+ and
Sonnet 4.6+. `name: 'web_search'` and `max_uses: 3` are unchanged.

**Money.** Web search bills at $10 per 1 000 searches; `src/pricing.ts` gains
`WEB_SEARCH_MICROS = 10_000n` and `costMicros` gains an optional server-tool count. The reservation
takes `max_uses × WEB_SEARCH_MICROS` on top of the token estimate as its upper bound; reconcile
reads `usage.server_tool_use.web_search_requests`. Every scout call debits her, per parent §8.

**Correction (Task 11):** the reservation also includes a per-search result-token allowance
(`SCOUT_SEARCH_RESULT_TOKENS = 6_000`, priced at the seat's plain input rate) alongside the flat
`WEB_SEARCH_MICROS` fee, for every one of the `max_uses` searches the tool allows — the provider
bills the pages a search fetches back as ordinary input tokens, which the flat fee alone does not
cover; `reconcile` still charges the true `actual` cost from `usage` regardless of this bound.
Additionally, the traveller's notebook is passed as `CallArgs.suffix` (via `renderNotebook`), the
same volatile-context mechanism the driver and reviewer use — this is what backs the prompt's
promise of "her party" and "their month" rather than the bare city name alone.

**Fencing.** The tool is `door: 'worker'`; `fenceResult` already wraps worker results in the
untrusted fence. The brief is additionally passed through `maskUntrustedText`.

**Parallelism.** One scout per driver step. Parent §7 mentions three parallel scouts; the loop
answers one `tool_use` per step by construction (plan 3). Recorded, not built.

## 3. The price half of `trimForContext` — a notice, not a rewrite

Parent §5 says prices past their supplier's `pricePersistence` window are "stripped from context
and the model is told to re-search". The transcript is persisted `tool_result` blocks; rewriting
them edits earlier turns, invalidates the cache prefix, and is the class of history edit the API
is moving to reject. The freshness gate already refuses any stale proposal.

**Built instead:** each driver step computes, from `tool_results` for this conversation, the source
ids whose age exceeds their supplier's `maxAgeSeconds` and appends to the volatile suffix (after the
notebook):

```
## Expired results
These ids are no longer quotable: <ids>. Re-search before proposing them.
```

Nothing is rewritten; the model is told exactly what the gate will refuse. Recorded as a deviation
from the parent's wording; the guarantee (no stale price reaches her) is the gate's and is
unchanged.

**Correction (Task 11):** the ids listed in the notice are masked with `maskIdChars`
(`[^A-Za-z0-9._:-] → '-'`, same 128-character cap as `sanitizeSourceId`), not `sanitizeSourceId`'s
`'?'` mask. `'?'` is the right choice for prose, where the string stays visually a sentence, but
the wrong one inside what reads as an identifier list — a hostile supplier-origin id in this notice
now reads as a mangled identifier rather than corrupting the sentence around it.

## 4. Drift monitor

**Two checks, one runner.** `runDriftMonitor(deps)` in `src/monitor/drift.ts`, plus
`netlify/functions/drift-monitor.mts` scheduled `0 3 * * *`, behind the shared secret like
`run-turn-background.mts`.

**Correction (Task 11):** the function accepts EITHER the shared secret OR Netlify's own scheduled
payload — not the shared secret alone. `src/monitor/authorise.ts` checks, in order: (1) an
`x-worker-secret` header, verified with the same timing-safe comparison `run-turn-background.mts`
uses — a present header always wins on its own correctness, never falling through even alongside a
forged scheduled body; (2) failing that, whether the request body matches Netlify's documented
scheduled-invocation shape, `{ next_run: "<ISO-8601 string>" }` — the marker Netlify's own scheduler
sends, since a cron trigger cannot attach a custom header. This second path is safe only because
**Netlify's own documentation states scheduled functions are not directly invocable by URL** —
"You can't invoke scheduled functions directly with a URL" — the same property `sweep.mts` (plan 1)
already relies on. **This means the `[functions."drift-monitor"]` `schedule = "0 3 * * *"` entry in
`netlify.toml` must never be deleted or renamed away**: doing so would turn this function back into
a plain HTTP endpoint reachable by anyone who can construct a `{ next_run: ... }` body, defeating
the second auth path entirely and exposing an uncapped-spend endpoint.

**Check 1, the canary.** For each of `driver`, `reviewer`, `front_desk`, `scout`: one fixed golden
request per seat (a small trip prompt; a small offer to review; a greeting; a city), a live call,
and a fingerprint:

```ts
{ seat, model: string, stopReason: string, outputBand: 'xs'|'s'|'m'|'l'|'xl',
  signal: string }   // driver: tool name chosen | reviewer: approved+issues count | front: label | scout: '' 
```

stored in `canary_runs` (migration 0015). Each run is diffed against the previous stored run for
the seat; a change in `model`, `stopReason` or `signal` is an alarm; an `outputBand` move of two
or more bands is an alarm.

**Correction (Task 11):** a seat canaried within the last 20 hours is skipped outright — no
transport call, no new `canary_runs` row — rather than re-run, so an at-least-once scheduler
invoking the function more than once in one nominal night does not re-run every seat's paid canary
call for nothing. 20 hours, not 24, gives room for a run that starts a little early or late without
treating the previous night's own run as "not recent enough." Only a ceiling-caused skip (below)
still raises the monitor's own "could not run" alarm; a recency-caused skip is the monitor behaving
correctly and is not itself alarm-worthy.

**Check 2, our own shape.** For the three full-capture seats, the newest `model_calls.request_shape`
is reduced to its stable part — every top-level key except `messages`, tool **names** only, cache
TTLs — and compared to the same reduction of `buildRequest` on a fixed input today. A difference
means what the deployed code sends is not what the repo says it sends.

**Correction (Task 11):** the "newest" row this check reads is era-keyed — filtered to
`prompt_version = SEATS[seat].promptVersion and model_config_id = SEATS[seat].modelConfigId`, the
seat's CURRENT configuration — not simply the newest row overall, and it excludes rows written by
`OPS_USER_ID` (the monitor's own canary calls, which by construction always match the golden shape
exactly and would otherwise make every seat's own most recent canary run "the newest row" after the
first-ever nightly run, permanently blinding the check to real drift). Without the era key, the
newest row immediately after a prompt or model-config bump is a pre-deploy row written under the
OLD configuration, and comparing it against today's golden shape would file a guaranteed false
positive on the deploy itself, every time, forever — nothing recorded that the alarm had already
fired for that same difference. **Alarms are deduped 7 days**: a shape or canary alarm whose
`detail` byte-matches (after a key-sorted JSON round trip) one already raised for the same
seat/check within the last 7 days is suppressed rather than re-raised, and the run result reports a
`suppressed` count.

**Alarms.** Any difference inserts a `drift_alarms` row (migration 0015: `seat`, `check`,
`detail` jsonb, `created_at`, `notified_at`) and calls `Notifier.alarm(a)` — the port from 3b gains
a second method; `LogNotifier` logs it. Best-effort, swallowed, like escalations.

**Ops budget.** The monitor's calls go through `reserve`/`reconcile` against a fixed
`OPS_USER_ID` (`00000000-0000-4000-8000-00000000000f`) so they never touch a traveller's counters,
but still count toward the global daily ceiling: a runaway monitor is capped like everyone else.

**Correction (Task 11):** the ops conversation is scoped to the calendar month
(`title = 'ops:YYYY-MM'`, UTC), not one conversation reused for the monitor's lifetime — a
lifetime-reused row would eventually cross `conversationCeilingMicros` permanently, silently
killing every future canary call with no logged skip. A fresh conversation each month resets the
ceiling on a schedule nothing has to notice or act on; a rare concurrent-run race near a month
boundary that inserts two rows for the same month is accepted, since each row's own ceiling still
independently gates what is charged to it. The global (account-wide) ceiling is read explicitly
before every canary call — the monitor has no upstream turn loop to get this check for free the way
a traveller's turn does from `decideNext` — and a ceiling-caused skip on either the ops
conversation or the global ceiling itself files one `drift_alarms` row
(`seat: 'monitor', check: 'canary', detail: { skipped, reason: 'ceiling' }`): a monitor that cannot
run some or all of its seats is drift-worthy on its own.

**Cheap seats.** Only the canary covers `scout`; no `request_shape` diff for any cheap seat
(their truncated rows carry NULL by design, backlog 2.5). Ruled, recorded.

**The live tests stay.** `test/*.live.test.ts` remain the CI-side canary; the monitor is the
production-side one.

## 5. CI

`.github/workflows/test.yml`, on `pull_request` to `main` and `workflow_dispatch`:

- `actions/setup-node` from `.nvmrc`, pnpm 9, frozen lockfile.
- A `postgres:16` service. `supabase/ci-bootstrap.sql` creates roles `anon` and `authenticated`
  (`nologin`) — the only things the migrations assume that a bare Postgres lacks; `pgcrypto` is
  created by 0001 itself. Then every `supabase/migrations/*.sql` in name order via `psql`. This is
  also the first automated proof that the migrations apply from zero.
- `DATABASE_URL` points at the service; `ANTHROPIC_API_KEY` and `GOOGLE_SEARCH_API` come from repo
  secrets; `LIVE_MODEL=1 LIVE_SUPPLIERS=1 pnpm test`, then `pnpm typecheck`, `pnpm lint`.
- A `scripts/ci-migrate.sh` applies bootstrap plus migrations so the same path runs locally
  against any empty database.

The only manual step is adding the two secrets.

## 6. Testing

- Front desk: each label, each fallback route, the `continue` step through `runTurn` (a front-desk
  step then a driver step in one turn, one `model_calls` row per seat, both debited once), the
  title written, the label stored, the ceiling path.
- Scouts: the request carries exactly the web search tool with `max_uses: 3`; the brief is
  redacted (a table of price shapes) and cut at 300 words; reservation includes the search cap and
  reconcile reads the search count; the result is fenced.
- Expired-results notice: present only for ids past their window, absent otherwise, never for
  another conversation's ids.
- Monitor: fingerprint stability on identical responses; each alarm condition; ops user charged,
  traveller counters untouched; shape reduction ignores `messages` and changes on a TTL change.
- CI: the workflow runs green on the PR that adds it, which is the test.
- Every rule gets the break-and-watch-it-fail check, per the repo's standing rule.

## 7. Rulings taken here

| Ruling | Why | Cost if wrong |
|---|---|---|
| Front desk runs in the turn, not the route | it is a paid call; the route has a 10 s cap and no ledger | none |
| `desk` default becomes `'front'` | the router needs a per-conversation flag and the column exists for it | existing rows stay on planning |
| Title comes from the front desk call | one Haiku call instead of two; `titler` stays declared, unused | a spare seat |
| `continue` step | she must not wait for a second turn after routing | one small worker branch |
| Scouts use the server-side web search tool, capped at 3 | parent §10 calls a brief "a paraphrase of untrusted pages" | ~$0.03 per scout on top of tokens |
| Price half is a suffix notice | history edits break caching and are being deprecated; the gate holds the guarantee | none |
| Monitor charges `OPS_USER_ID` | parent §8: an ops budget, not hers; global ceiling still applies | one reserved uuid |
| Cheap seats: canary only | truncated rows have no shape to diff | scout shape drift is invisible |
| CI database is a service container | no secret, no shared state, proves migrations from zero | RLS/roles differ from Supabase's; policies (plan 4) will need a Supabase-shaped test |
| Scout tool type is `web_search_20250305`, not `web_search_20260209` | Haiku 4.5 400s on the dynamic-filtering variant (Opus 4.6+/Sonnet 4.6+ only) | none — the basic variant is irrelevant-feature-poorer, not wrong |
| Front desk/scout/expired-notice masking uses `maskControlChars`/`maskIdChars`, not `maskUntrustedText`, for our-own-model prose and id-shaped lists | `maskUntrustedText`'s 128-cap and non-ASCII mask corrupts legitimate prose (`Málaga` → `M?laga`) and mangles id lists | a few lines; no injection-guard weakened |
| Drift-monitor auth accepts the shared secret OR Netlify's `{ next_run }` scheduled payload | Netlify's own scheduler cannot attach a custom header; Netlify documents scheduled functions as not URL-invocable | a deleted `netlify.toml` `schedule` entry would expose an uncapped-spend endpoint |
| Shape check is era-keyed (`prompt_version` + `model_config_id`) and excludes ops rows; alarms deduped 7 days | a pre-deploy row compared to today's shape files a guaranteed false positive on every version bump; an undeduped alarm re-pages every night for a known, unresolved drift | small — the check may go quiet until the first post-deploy real call, which is correct |
| Monitor skips a seat canaried within the last 20 hours | an at-least-once scheduler must not re-run every seat's paid canary call for nothing | none — a ceiling-caused skip still alarms; a recency-caused skip does not, correctly |
