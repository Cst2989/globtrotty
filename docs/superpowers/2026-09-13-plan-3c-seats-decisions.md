# Plan 3c — Seats Half — decisions taken during execution

Rulings made while executing `docs/superpowers/plans/2026-09-13-plan-3c-seats.md`, recorded
because they were taken on the author's behalf so the work could continue. Same format as
`2026-09-13-plan-3b-gates-decisions.md`: what was decided, why, and what it costs if it was wrong.

Branch: `feat/plan-3c-seats` · 12 tasks (0–11), each reviewed individually — Task 3 took one fix
round, Task 5 took one fix round, Task 7 took one fix round, Task 9 took one fix round — then a
whole-branch final review that returned six Important fixes and parked six residuals, addressed in
one final fix wave (15/15 addressed, no new Critical/Important). **793 tests passing, 11 skipped**
(live external-API suites, gated) at merge. The `L1` live pins (front desk, scout) are
code-complete and reviewed but unverified live — see the Parked section.

---

## The four deviations from the plan header

### Deviation 1 — the price half of `trimForContext` is a suffix notice, not a rewrite

**Ruling: each driver step appends the ids of expired `tool_results` to the volatile suffix as an
"Expired results" notice, rather than rewriting the persisted `tool_result` blocks the parent spec
describes ("stripped from context and the model is told to re-search").**

The transcript is persisted `tool_result` blocks; rewriting them edits earlier turns, invalidates
the cache prefix, and is the class of history edit the API is moving to reject. The freshness gate
already refuses any stale proposal, so the guarantee (no stale price reaches her) is the gate's,
not this notice's.

**Cost if wrong:** none named — the gate is the actual guarantee; the notice is a courtesy that
tells the model what the gate will refuse before it wastes a step proposing it.

### Deviation 2 — the title comes from the front desk's one call; `titler` stays declared, unused

**Ruling: folding the title into the front desk's structured-output call, rather than a second
call to the declared `titler` seat.**

One Haiku call produces both the routing label and the title in the same response; a second call
purely for a title would double the front desk's latency and spend for no benefit `new_trip`
doesn't already get from the first call. `titler` stays in the `model_calls.seat` constraint,
recorded as spare in the backlog.

**Cost if wrong:** a spare, unused seat declaration — no functional cost.

### Deviation 3 — one scout per driver step; parallel scouts not built

**Ruling: `research_destination` is one worker-door tool called once per driver step, not three
scouts dispatched in parallel as the parent spec's prose describes.**

The loop answers one `tool_use` per step by construction (plan 3's own shape); building parallel
dispatch needs a loop that can answer several tool calls in one step, which this plan does not
touch. Recorded, not built.

**Cost if wrong:** none — a driver step that wants three cities takes three steps instead of one;
slower, not wrong.

### Deviation 4 — `check_transfers` is not built

**Ruling: no `check_transfers` tool ships in this plan.**

No data source was ever chosen for it. Out of scope per the plan header and the spec's own "Scope"
line.

**Cost if wrong:** none — nothing regresses; a tool that never existed cannot be missed by a test.

---

## Task 0 — two one-liners from 3b's final review

**Ruling: the reviewer's only finding (the `Co-Authored-By` model name on the commit) is not a
code defect — attribution names whichever model wrote the commit, which is accurate for that
commit; no amend.**

Each subagent sees its own model's attribution reminder; a mismatch across commits in one branch
is expected, not a bug.

**Cost if wrong:** none.

---

## Task 1 — savepoints for two rejected inserts in one transaction

**Ruling: Task 1's test 3, which asserts two separate check-constraint violations, wraps each
rejected insert in its own savepoint.**

An aborted Postgres transaction cannot run a second statement; without a savepoint per rejected
insert, the second assertion would run against a transaction Postgres has already aborted, and
either error confusingly or (worse) silently not exercise the second constraint at all.

**Cost if wrong:** none — this is strictly a test-authoring fix, not a behavior it changes.

---

## Tasks 2 and 3 ordering, and the Haiku `thinking` omission

**Ruling: Task 2 (the worker's `continue` step) runs before Task 3 (the front desk agent) so the
front desk's return type already exists when it is written; Task 5 (redactor/`cutAtWords`) runs
before Task 7 (the scout) for the same reason. Task order stays 0,1,2,3,4,5,6,7,8,9,10,11.**

Found during the plan's pre-flight scan, before either task started.

**Cost if wrong:** none — sequencing only.

**The Haiku `thinking` omission (Task 3).** Found the same pass: `buildRequest` was sending
`thinking: { type: 'adaptive' }` unconditionally, but a Haiku seat with `effort: null`
(`SEATS.front_desk`, `SEATS.scout`) cannot receive a `thinking` block at all — only Opus/Sonnet
seats with a configured `effort` can. **Ruling: `buildRequest` omits the `thinking` field entirely
when `seat.effort === null`, rather than sending an empty or default one.** Task 3 owns the
`buildRequest` edit; Task 6 pins it with a unit test; Task 9's live front-desk/scout pins are what
prove it live (`req_011Cf2KXTnch91wM4macQKMC` for `front_desk`, later corrected for `scout`, see
Task 9 below).

**Cost if wrong:** every Haiku-seat call would 400 outright — this would have been caught
immediately by any live pin, but the fix landed at design time rather than after a live failure.

---

## Task 3 — front desk review: `maskControlChars`, `anyOf`, faq masking

**Ruling: fix all three Important findings from Task 3's review in one round.**

1. `FRONT_SCHEMA` used `type: ['string', 'null']` for nullable fields, outside the documented
   structured-output subset, and the only test compared the schema to itself. **Fixed:** the
   schema now uses `anyOf: [{ type: 'string' }, { type: 'null' }]`, and the test asserts on the
   schema's own content.
2. `maskUntrustedText` caps at 128 characters and masks non-ASCII to `'?'` — correct for
   supplier-origin strings, wrong for the front desk's own answer/title, where a faq answer would
   truncate mid-sentence and "Málaga" would become "M?laga". **Fixed:** a new `maskControlChars` in
   `src/sanitize.ts` — strips only C0/C1 control characters and ` `/` `, keeps Unicode
   letters, no length cap — for OUR OWN model's prose. Applied to the front-desk answer and title
   (title additionally sliced to 120 characters), and — since 3b's cashier and reviewer paths
   applied the 128-cap function to their own rendered text too — `proposalPath.ts`'s two
   reviewer-issue sites and `cashier.ts`'s `render()` switch to it as well. `maskUntrustedText`
   stays for supplier-origin ids and strings. Task 7's scout brief uses `maskControlChars` for the
   same reason, in place of a cap-only option the brief had originally specified.
3. Answer masking was untested. **Fixed:** a faq-answer masking test.

Also: the prompt no longer claims "first message" — a faq answer can be a follow-up too, since faq
parks the turn at the front desk rather than ending the conversation.

**Cost if wrong:** a few lines each; reviewer-issue rendering loses the 128-character cap (zod
already caps issues at 500 characters, so this is a formatting change, not a new exposure).

*Minor deferred:* `lastUserText` duplicated from `driver.ts`; `limit_reached` strings duplicated;
`FrontLabel` imported by the repo layer from `agents` (type-only); `readDesk`'s throw untested;
`SEATS.front_desk`'s dated Haiku id is proven only by the live canary (Task 9).

---

## Task 5 — `redactPrices` widened before the scout consumes it

**Ruling: fix `redactPrices`'s gaps now, before Task 7's scout depends on it, rather than after.**

Task 5/6's review found `redactPrices` missed price shapes a scout will plausibly write: postfix
currency symbols ("89€"), numeric ranges ("$200-400" leaking "400"), spelled-out currencies ("89
euros", "50 dollars", "12 pounds"), and k-suffixes ("USD 1.2k"). The plan's own doc comment names
"from €89" surviving as the one failure this product must not have, and the redactor's table was
the ruling author's own to extend.

**Fixed:** the pattern table gained postfix-symbol, range, spelled-currency, and k-suffix rows.

**Cost if wrong:** over-eager redaction of a harmless number (e.g. "population 500,000 EUR") —
the safe direction, never a leaked price.

---

## Task 7 — the scout: a withdrawn ruling corrected, `SUPPLIER_DOORS`, search-token reservation, the notebook suffix

**Ruling (pre-review): a bad uuid in the brief's seed was fixed, and `tools.test`'s
fixture-sync check was extended for the worker-door entry.** Cost: none.

**Ruling (review, four findings, all fixed):**

1. **WITHDRAWN AND CORRECTED — city masking.** The plan's own earlier text called for
   `maskUntrustedText(city)` on the scout's `city` argument. Review caught that this turns "Málaga"
   into "M?laga" — the same non-ASCII-mangling defect Task 3 had just fixed for the front desk's
   own prose. **The earlier ruling was wrong; corrected:** `city` is driver-written (our own
   model's text, not supplier-origin), so it uses `maskControlChars` — zod's `.max(80)` on the tool
   schema is the length bound, not a cap function. A test pins that Málaga survives intact and that
   text over 128 characters is not truncated.
2. **`SUPPLIER_DOORS` widened.** `research_destination` is metered (Anthropic bills per web
   search) and rate-limited (`max_uses: 3`), but was reachable with no per-turn supplier-call
   budget check at all — the same code-door gap 3b's Task 8 closed for `hand_off_to_booking`.
   **Fixed:** `research_destination` added to `SUPPLIER_DOORS`; one hand-off/scout call counts as
   one supplier call against the turn's budget.
3. **Search-result token allowance added to the reservation.** The reservation covered only the
   flat `WEB_SEARCH_MICROS` fee per search, but the provider bills the pages a search fetches back
   as ordinary input tokens — unbounded before this fix. **Fixed:** `SCOUT_SEARCH_RESULT_TOKENS =
   6_000` (a per-search bound, not a measurement — `reconcile` still charges the true `actual` from
   `usage`), added to `extraMicros` alongside the flat fee, for all `SCOUT_MAX_SEARCHES` searches
   the tool allows.
4. **The notebook suffix.** `scout.md` promised the model "her party" and "their month", but the
   call never sent the notebook. **Fixed:** `researchDestination` now takes the traveller's
   `Notebook` and passes `renderNotebook(notebook)` as `CallArgs.suffix` — the same volatile-context
   mechanism the driver and reviewer already use, landing after the last cache breakpoint so a
   scout call never invalidates anything cached ahead of it.

Minors fixed the same round: an empty-brief test; a stale-fixture invariant; a literal pin on the
tool object; `user_prompt` recorded as the text actually sent (city line + suffix), not the bare
city; `driver.md` guidance that `research_destination` costs money and counts against the per-turn
supplier budget; and `scout.md`'s unmet promise (fixed as (4) above).

**Cost if wrong:** a few lines each; the fatter reservation over-reserves briefly, then reconciles
down to the true cost.

---

## Task 8 — expired-results notice test timing

**Ruling: the brief said "20 minutes after the second batch", which would expire both batches at a
900-second ttl; the implementer used 10 minutes instead, so only the intended batch expires.**

**Cost if wrong:** none.

*Note carried forward:* Task 8 reported intermittent DB-test timeouts on the full suite (different
files each run, reproducible on the unmodified tree) — the suite is now ~730+ DB-backed tests
against a remote Supabase project. Addressed at Task 10 (below).

*Minor deferred:* `renderExpiredNotice` has no direct unit test; the "no notice" driver test uses
an empty corpus rather than a fresh, unexpired one (later tightened at the final review's M10 fix,
see below).

---

## Task 9 — the drift monitor

### `web_search_20260209` → `web_search_20250305`

**Ruling: change `WEB_SEARCH_TOOL.type` in `src/agents/scout.ts` (and the literal pin in
`test/scout.test.ts`) from `web_search_20260209` to `web_search_20250305`, then re-run the live
scout pin.**

The plan header specified `web_search_20260209`. Task 9's first live run confirmed live
(`req_011Cf2KXZdMSZekaYCipHDy5`): a 400, "`'claude-haiku-4-5-20251001' does not support
programmatic tool calling. The following tools have `allowed_callers` that require it: web_search.
Explicitly set `allowed_callers=["direct"]` on these tools, or use a model that supports
programmatic tool calling.`" `web_search_20260209` is the dynamic-filtering variant, which runs
code execution under the hood and is only supported on Opus 4.6+/Sonnet 4.6+; the scout's seat
(Haiku 4.5) needed the basic variant instead. This is a plan defect, not an implementation one.

Re-ran `LIVE_MODEL=1 pnpm vitest run test/driver.live.test.ts` once after the fix (commit
`a945f5f`): all 5 tests passed, including the scout pin — request id
`req_011Cf2KvdqVzKZahFgJboUnM`, `usage.server_tool_use.web_search_requests` a real number.

**Cost if wrong:** the basic variant lacks dynamic filtering — irrelevant to a 300-word brief that
never needed it.

### Review — four findings, all fixed

1. **Critical — no auth check on `drift-monitor.mts`.** The spec names a shared-secret check
   (section 4: "behind the shared secret like `run-turn-background.mts`"), but the function shipped
   with none — a paid, unauthenticated endpoint that reserves and spends real money against
   `OPS_USER_ID` on every call. **Fixed:** `src/monitor/authorise.ts`, with two accepted paths:
   (a) an `x-worker-secret` header, checked with the same timing-safe comparison
   `run-turn-background.mts` uses; (b) **Netlify's own scheduled-invocation payload**, since
   Netlify's scheduler cannot attach a custom header to a cron trigger — recognised by its
   documented body shape, `{ next_run: "<ISO-8601 string>" }`. A present `x-worker-secret` header
   always wins on its own correctness; a wrong secret never falls through to the scheduled-marker
   path even alongside a forged `next_run` body.

   **This path's safety depends entirely on Netlify not exposing scheduled functions over a plain
   URL.** A fix-round re-review investigated this directly: Netlify's own documentation states
   plainly, **"You can't invoke scheduled functions directly with a URL"** — and `sweep.mts`
   (plan 1) already relies on the identical property. **Ruling: accepted as sound** — the
   `next_run` path is not a bypass, because nothing outside Netlify's own scheduler can produce a
   request that both omits the secret header and carries that body shape. The dependency is real,
   though: it is recorded here and in the spec correction and backlog as a coupling to the
   `netlify.toml` `schedule` entry that must never be silently removed.
2. **Important — the ops conversation never rotates.** A single lifetime-reused ops conversation
   eventually crosses `conversationCeilingMicros` permanently, silently killing the monitor's
   canary calls in roughly two months, with skips unlogged. **Fixed:** `ensureOpsConversation`
   scopes by UTC calendar month (`title = 'ops:YYYY-MM'`); a fresh conversation each month resets
   the ceiling on a schedule nothing has to notice or act on. A concurrent-run race (two runs near
   a month boundary both inserting a row for the new month) is accepted as minor — no migration, no
   correctness impact, since each row's own ceiling still independently gates what is charged to
   it.
3. **Important — the shape check compared against its own canary rows.** `newestRequestShape` read
   the seat's own newest `model_calls` row, which after the very first nightly run is always the
   monitor's own canary write — a tautological match that would never again see real drift.
   **Fixed:** the query excludes `user_id = OPS_USER_ID` rows, so it only ever compares against
   real production traffic.
4. **Important — the global ceiling was never read on the monitor path.** A traveller's turn gets
   the account-wide ceiling check for free from `decideNext` before the driver agent is even
   invoked; the monitor has no such upstream loop. **Fixed:** `callCanary` reads
   `readSpendFailClosed` fresh before every canary call and folds `globalMicros` into
   `firstCeilingReached` alongside the conversation/daily values.

Minors fixed the same round: `notifyAlarm` stamps `notified_at` outside the notifier's own `try`
(the same M2 pattern as 3b.5's escalation fix); a shape alarm's `detail` is a key-level diff, not
two whole copies of the reduced requests; a non-empty `skipped` set is itself logged and alarmed
(`seat: 'monitor'`) rather than silently swallowed. Plan/spec text still naming
`web_search_20260209` was flagged for this task (Task 11) — see the spec corrections below.

**Cost if wrong:** a few lines each — except (1), where the cost of being wrong would have been a
live, unauthenticated, money-spending endpoint.

*Minor deferred:* `readSpendFailClosed` throwing after `reserve` leaves an unrefunded ops
reservation until month rotation (later tightened at the final wave's M11 fix — see below, which
added a refund-then-rethrow); an inner `req` shadowed the handler's own `req: Request` in
`drift-monitor.mts`'s transport closures (fixed at the final wave, M12); the skip alarm fired
nightly with no dedupe (fixed at the final wave, part of F2); ops conversations accrue monthly (by
design, see (2) above).

---

## Task 10 — vitest timeout

**Ruling: set vitest's `testTimeout` to 30000 globally (no prior configuration), to address the
remote-DB flakiness Task 8 reported.**

**Cost if wrong:** slow failures take longer to surface — no correctness cost.

Task 10 completed locally; acceptance is the first green PR run, which needs a push, a PR, and two
repo secrets (`ANTHROPIC_API_KEY`, `GOOGLE_SEARCH_API`) — user action, not yet done. See the spec
correction and backlog.

---

## Final review — six Important fixes (F1–F6)

The whole-branch final review returned six Important findings; all six were fixed in one wave
(commits `479fb12..d3981f8`, 15/15 findings addressed including minors, no new Critical/Important).

### F1 — `driver.md` changed under `driver@2`

**Ruling: bump the driver prompt version to `driver@3`.**

Task 7 added a Scouts section to `driver.md` while the plan's own Global Constraints had frozen the
prompt version at `driver@2` — a plan defect (the constraint listed `driver@2 (unchanged)` while a
later task in the same plan edited the file it names). A prompt file edit is a version bump,
always. All `driver@2` literal pins across `test/proposals-repo.test.ts`, `test/drift.test.ts`, and
`test/driver.test.ts` were updated to `driver@3`.

**Cost if wrong:** a stale prompt-version pin across the test suite — caught immediately by any of
those tests, not a runtime risk.

### F2 — the shape check alarmed nightly forever; alarms had no dedupe

**Ruling: key `newestRequestShape` to the seat's CURRENT era (`SEATS[seat]`'s `promptVersion` +
`modelConfigId`), and add a 7-day dedupe (`recentIdenticalAlarm`) in front of both the shape and
canary alarm sites.**

The newest traveller row predated the deploy whenever a prompt or model-config bump had just
shipped, so comparing it against today's `goldenArgs` shape would alarm on the deploy itself,
forever, since nothing was recording that the alarm had already fired. **Fixed:**
`newestRequestShape` filters on `prompt_version = SEATS[seat].promptVersion and model_config_id =
SEATS[seat].modelConfigId`, so a pre-deploy row is never compared against today's golden shape —
the era-keyed check may go quiet until real post-deploy traffic arrives, which is correct, not a
gap. A drift already alarmed on within the last 7 days (byte-identical detail, after a key-sorted
JSON round trip) is suppressed rather than re-paged; suppressions are counted and returned as
`suppressed` on the run result.

**Cost if wrong:** small — the era-keyed shape check may report nothing on a seat until the first
real post-deploy call, which is the intended behavior, not a defect.

### F3 — `maskControlChars` turned newlines into `'?'` in text she reads

**Ruling: line breaks (`\n`, `\r`, `\t`, ` `, ` `) now map to a single space, not `'?'`,
in `maskControlChars`; every other C0/C1 control character still becomes `'?'`.**

Our own model's prose can legitimately contain a paragraph break or a pasted tab; a run of visible
`'?'` where a line break belongs reads as corruption rather than the harmless reflow it is. The
newline-injection guard this function exists for is about the structure a line break creates in
the model's context, not the character displayed — collapsing to a space defeats the injection
exactly as completely as `'?'` did.

**Cost if wrong:** a few lines — this is purely a display-quality fix on our own model's output;
the injection guard itself is unchanged in effect.

### F4 — expired ids landed in the suffix unfenced with a 128-char printable-ASCII mask

**Ruling: a new `maskIdChars` (`[^A-Za-z0-9._:-] → '-'`, same 128-character cap as
`sanitizeSourceId`) for a supplier-origin id rendered where it reads as an id rather than as prose;
`renderExpiredNotice` (`src/agents/driver.ts`) now uses it instead of `sanitizeSourceId`.**

`sanitizeSourceId`'s `'?'` mask is the right choice for prose (it stays visually a sentence) but
the wrong one inside what reads as an identifier list — a hostile id in the expired-results notice
now reads as a mangled identifier rather than corrupting the sentence around it.

**Cost if wrong:** a few lines — cosmetic within an already-fenced, already-capped surface.

### F5 — `releaseForContinuation` dropped the run's spend

**Ruling: `releaseForContinuation` now takes `spendMicros` and adds it to
`turns.spend_usd_micros` in the same fenced update that `completeTurn`/`failTurn` already use.**

A turn that hit `continue_later` (the front desk's `continue` step falling into that path) reported
0 for whatever it had already self-debited mid-turn — pre-existing, but only reachable on every
first turn once the front desk's `continue` step exists. `runTurn` passes `turnSpend.total` and
resets it to `0n` immediately after, since the re-invocation this triggers is a fresh `runTurn`
call whose own `turnSpend` starts at `0n` — the same micros must never be added twice.

**Cost if wrong:** every continued turn silently under-reports its true spend against the daily and
per-conversation ceilings — the same class of money-guardrail defect 3b's F4 fixed for the
reviewer's accumulator, now for the front-desk-to-driver handoff.

### F6 — the monitor was not idempotent under at-least-once scheduling

**Ruling: a seat canaried within the last 20 hours is skipped outright (`reason: 'recent'`) — no
transport call, no new `canary_runs` row — rather than re-run.**

A scheduler that invokes the function more than once for one nominal "night" (at-least-once
semantics) would otherwise re-run every seat's paid canary call for nothing. 20 hours, not 24,
gives room for a run that starts a little early or late without treating the previous night's own
run as "not recent enough." Only a `'ceiling'` skip still raises the monitor's own "could not run"
alarm; a `'recent'` skip is the monitor behaving correctly and is not itself alarm-worthy.

**Cost if wrong:** small — worst case, a 20-hour window slightly under- or over-shoots "one canary
per seat per night" by a few hours either side; never a money or correctness defect.

**(15) The dated Haiku model id stays a watch item**, per the final review — `claude-haiku-4-5-20251001`
is the one current model with a dated snapshot; nothing in this plan changes that, but it remains
the one seat id that could silently go stale if a future Haiku release deprecates the snapshot.

Minors 7–14, also fixed the same wave: `Math.ceil` before `BigInt` on the scout's search-token
reservation term (a fractional per-token price would otherwise throw a `RangeError`, mirrored in
both `scout.ts` and `monitor/drift.ts`); `researchDestination` now surfaces failed web searches
(`web_search_tool_result` blocks carrying an error object) as a `[some web searches failed: ...]`
trailer instead of silently reading as a complete, successful brief; `routeToPlanning`/
`recordFrontLabel` now fail closed (`returning id`, throw on zero rows) instead of silently doing
nothing on a conversation/user id pair matching no row; `'day'`, `'week'`, and `'each'` dropped from
`redactPrices`'s `UNIT` list (a bare count before one of those words has nothing to do with money);
`callCanary` refunds its reservation before rethrowing if `readSpendFailClosed` itself throws
(previously would have stranded the reservation); the shadowed `req` in `drift-monitor.mts`'s
transport closures renamed to `body`; `test/drift.test.ts`'s shape fixture uses the real
`web_search_20250305` tool type; the L1 live pins were strengthened to send the real prompt files
and assert the scout call actually performs a search (`>= 1`) and returns a
`web_search_tool_result` block, rather than proving only that the call did not error.

**Cost if wrong:** small each.

---

## Parked

The final review parked six residuals, none load-bearing, filed to the backlog rather than fixed
here:

- `drift-monitor.mts`'s own `suppressed` count is computed but not logged/returned anywhere an
  operator would see it outside a direct call to `runDriftMonitor`.
- The monitor's own ceiling-skip alarm (`seat: 'monitor'`) bypasses the 7-day dedupe — it is not
  itself deduplicated the way a seat's canary/shape alarm is, so a persistent ceiling problem pages
  every night rather than once.
- Alarm dedupe can silence a re-occurring flap whose detail happens to byte-match one already
  raised within the last 7 days, even if the seat recovered and re-broke in between.
- Search error codes are appended to the scout's brief unmasked, and are dropped entirely when the
  brief itself is empty (the "no brief" early-return paths never reach `searchErrorTrailer`).
- The L1 live-pin task duplicates prompt-file-reading code already present in `src/agents/*.ts`
  rather than importing it.
- The drift tests' fixed clock (`GOLDEN_NOW`, and the fixed-`now()` fixtures in `test/drift.test.ts`)
  sits at some distance from the 20-hour recency guard (F6) in wall-clock terms, which is accepted
  as a test-authoring convenience, not a production risk.
- **(M9, accepted)** "120 per day" and similar bare-count-plus-unit phrases are no longer redacted
  by `redactPrices` after dropping `'day'`/`'week'`/`'each'` from `UNIT` — a deliberate trade
  (false negatives on a phrase with no price reading, rather than false positives on ordinary
  counts).

Ruling on all six: **real, none load-bearing.** Cost if wrong: an operator reads "alarms: 0" on a
fully-suppressed night rather than seeing the true (higher) count of drift signals that were real
but deduped or dropped — a visibility gap, not a money or correctness one.

**Additionally parked, found while writing this document (Task 11): the Anthropic key's credit
balance is too low.** Every `LIVE_MODEL=1` run in this branch — including the pre-existing tests,
unrelated to this branch's changes — fails identically with a 400, "Your credit balance is too low
to access the Anthropic API" (request ids `req_011Cf2S6jPMDQ2qkjx1nqzhu`, `req_011Cf2S6krA6RLjPLZ1bpLq3`,
`req_011Cf2S6mx8pDrrgiQ6Y9xEK`, `req_011Cf2S6o2NqqGi5iq6giNkc`, `req_011Cf2S6pPizbuqrQyft3tbt`).
The key authenticates; the account has no spendable balance. This means:

- The L1 live pins (front desk, scout) are code-complete and reviewed but **unverified live** —
  someone with billing access must re-run `LIVE_MODEL=1 pnpm vitest run test/driver.live.test.ts`
  once credit is available, and loosen the scout assertion to `>= 0` searches if the golden city
  turns out to provoke zero searches in practice.
- CI's live suites (`LIVE_MODEL=1 LIVE_SUPPLIERS=1 pnpm test` in `.github/workflows/test.yml`)
  cannot succeed on the first PR run until the balance is topped up.
- The nightly drift monitor cannot make a single real canary call in production until the balance
  is topped up — every call will 400 with the same billing error, which is not distinguished from
  a genuine `provider_down` classification anywhere in this plan's code.

**Cost if wrong:** none — this is an environment/billing fact, not a code judgment call; the fix is
purely operational (top up the account).
