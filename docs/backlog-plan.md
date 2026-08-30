# Backlog — carried debt after plans 1 and 2

Everything deferred with a recorded reason across plans 1 and 2, triaged by severity.

**Sequencing:** plan 3 is planned and delivered first. Then this. The exception is Tier 0 —
two items plan 3 cannot be built correctly without, which are prerequisites rather than backlog.

**A note on what is NOT here.** Several items commonly mistaken for backlog are actually *plan 3
scope*, because plan 3 is what creates them. They are listed in Tier 1 so they are not
double-counted, but they belong in plan 3's own task list, not in a follow-up pass.

---

## Tier 0 — prerequisites for plan 3

### 0.1 `step.run()` is not wrapped in `withHeartbeat`
`src/worker.ts:193`. Plan 1's own decisions log marks this **"REQUIRED FOR PLAN 3"**.

`withHeartbeat` wraps the agent call but not the side-effecting tool execution. Today the echo
agent has no tools, so nothing is exposed. Plan 3 introduces real supplier calls: a Kiwi MCP
search or a SearchApi request that exceeds the 90-second staleness window gets swept out from
under a live worker.

The fencing token keeps this *correct* — the superseded worker writes nothing — so the failure
is duplicate supplier calls rather than corruption. But duplicate calls cost money and burn
rate limits against metered APIs, which is exactly what 1.2 exists to cap.

**Fix:** wrap `step.run()` the same way the agent call already is. One line, plus a test that a
tool call longer than the heartbeat interval keeps `heartbeat_at` advancing.

### 0.2 There is no error classifier — every error maps to `provider_down`
`src/worker.ts:66`. Recorded honestly in plan 1: the echo agent cannot produce a real provider
error, so the classifier was deferred until a model client existed.

Plan 3 *is* that model client. Without a classifier the harness cannot tell a permanent failure
from a transient one, so a malformed request (400) is retried on the same schedule as a rate
limit (429) — burning the turn's attempts and eventually reaping it as a crash loop.

The taxonomy is available and does not need inventing. The Anthropic SDK exports typed error
classes; check most specific first:

| SDK class | HTTP | Retry? | Maps to |
|---|---|---|---|
| `Anthropic.BadRequestError` | 400 | never | a permanent fault — park or fail the turn |
| `Anthropic.AuthenticationError` | 401 | never | terminal; alert |
| `Anthropic.RateLimitError` | 429 | yes, honour `retry-after` | `provider_down` |
| `Anthropic.APIError` (5xx) | 5xx | yes, with backoff | `provider_down` |
| `Anthropic.APIConnectionError` | — | yes | `provider_down` |

**Also new since the spec was written, and not in `turns.fail_reason`:** `stop_reason:
"refusal"` is an HTTP **200** with a `stop_details.category`. It is not an error and will not
throw — code that only inspects exceptions will treat a refusal as a successful empty turn.
Plan 3 must check `stop_reason` before reading `content`, and `fail_reason` needs a value for it.

---

## Tier 1 — belongs in plan 3, listed here only so it is not double-counted

| Item | Why it is plan 3's, not backlog |
|---|---|
| **`model_calls` is written by nothing** | The spec calls it "the append-only cost ledger; both counters are derived from it". It has no writer because no model call exists yet. Plan 3 writes the first one, and must derive `conversations.spend_usd_micros` and `daily_usage` from it rather than alongside it. |
| **Per-turn supplier-call budget** (spec §8) | Deferred in plan 2 because `search()`/`quote()` had no callers outside tests. Plan 3 creates the call sites. §8 names its absence as a v1 defect being fixed. |
| **`gate_results.round` has no uniqueness** — **CLEARED by migration 0013** (`7fb343e`, `supabase/migrations/0013_gate_results_round_unique.sql`) | No unique constraint on `(conversation_id, proposal_id, round, gate)`. Two `runGates` calls in one turn that forget to increment `round` write two full seven-row sets and the fire-rate double-counts. Plan 3 wires the first caller — it must set `round` deliberately, and probably ship the constraint. The shipped index is keyed `(turn_id, round, gate)`, not `(conversation_id, ...)` — `round` is derived per turn, not per conversation — and is partial on `turn_id is not null` to scope it to live turns rather than orphans left by `turn_id`'s `on delete set null`. |
| **Prompt caching structure** | Plan 1 corrected the breakpoint layout on paper; nothing implements it. Current constraints: max 4 breakpoints per request, ~1024-token minimum cacheable prefix, render order `tools` → `system` → `messages`. |

---

## Tier 2 — real debt, cost accrues while it waits

### 2.1 `tool_results` is not append-only — RESOLVED
**Cleared by migration 0011** (`887d046`, `supabase/migrations/0011_tool_results_append_only.sql`).
`recordResults` no longer upserts; the `unique (conversation_id, source_id)` constraint that
forced the upsert is dropped, and `rehydrate` reads the newest row per `source_id` via
`distinct on (conversation_id, source_id) order by fetched_at desc, id desc`, served by a new
`tool_results_newest_per_source` index. The `id desc` tiebreak is deliberate, not decorative —
`d6feaad` replaced the original 2-row test (which could not fail regardless of ordering) with a
500-row test across forced seq/index/bitmap scan shapes that only passes with the tiebreak
present. **What this creates, not clears: see the new item below on `tool_results` growth.**

`src/repo/toolResults.ts`. Spec §6 says "untrimmed, append-only". `recordResults` uses
`ON CONFLICT DO UPDATE`, so a re-search overwrites the prior quote.

**This is the only backlog item whose cost grows the longer it waits.** Every re-quote destroys
one historical price, unrecoverably. Anything that became a proposal is safe (`proposals.itinerary`
holds the rehydrated snapshot); gate runs that never became proposals are not, so slice 2 cannot
reconstruct what a gate actually saw.

The final review established the spec is *not* ambiguous here — §6 says append-only and never
claims uniqueness; the uniqueness requirement came from plan 2's own plan text. So this is a
deliberate deviation, not a licensed one.

**Fix (already written down in `src/repo/toolResults.ts`):** row per fetch, `rehydrate` takes
the newest per `source_id`, drop `unique (conversation_id, source_id)` and replace it with an
index supporting newest-per-id. Do it before slice 2 needs replay.

### 2.2 The `count ?? 0` ban has no enforcement — RESOLVED
**Cleared.** `eslint.config.js` now carries a `no-restricted-syntax` rule banning
`?? 0` (and, as an incidental but verified side effect of how esquery stringifies
literals, `?? 0n`), with a `lint` script (`"lint": "eslint ."`) in `package.json`.

**Its limits:** the rule is scoped to `files: ['src/repo/**/*.ts']`, not the whole
repo. That scope is deliberate, not an oversight — a repo-wide selector produced a
genuine false positive at `src/gates/pipeline.ts:86` (`args.round ?? 0`, an
ordinary retry-round counter, not a spend read), and `src/repo/**` is where the
database reads that feed money ceilings live today. A `?? 0` on a spend read
introduced anywhere outside `src/repo/**` — e.g. inline in a new call site that
doesn't go through the repo layer — is **not** caught by this rule. The selector
also doesn't catch a disguised right-hand literal (`?? (0 as number)`, `?? +0`,
etc.), though no code in the repo does that today.

This is a money guardrail: `count ?? 0` converts "I cannot confirm usage" into
"zero spent", disabling a ceiling at the moment it is needed. Enforcement now
matches the spec's claim for the surface it covers; expanding coverage beyond
`src/repo/**` is future work, not open debt from this item.

### 2.3 `model_calls` cannot reconstruct a driver call, though `capture_policy` says `full` — RESOLVED
**Cleared by migration 0012** (`66e7568`, `supabase/migrations/0012_model_calls_request_shape.sql`).
`model_calls.request_shape jsonb` now stores the assembled request (`buildRequest(args)`'s
return, redacted the same way `response` is) whenever `capturePolicyFor` returns `'full'`.
`driver.ts` calls `buildRequest(args)` a second time at the record site rather than threading it
through `callModel`'s return, preserving the single-assembly-path invariant from a prior review
finding — `buildRequest` is pure and `placeBreakpoints` deep-copies its input, so the second call
yields exactly what was sent. **What this does not clear: see the new item below — the column is
NULL for every pre-0012 row and for every truncated cheap-seat row, neither backfillable, and a
scoping question this raises for the drift monitor is flagged for the next plan.**

`src/agents/driver.ts` (the `recordModelCall` call), `src/repo/modelCalls.ts:80,106`. §7 makes
driver rows always `full` *"because they are the eval corpus part 3 reads and the fine-tuning
corpus part 4 reads"* — but what is actually stored is the raw `system` string and
`lastUserText(...)`, the last thing SHE said. On step 3 of a multi-step turn, `user_prompt` is
still her opening message, byte-for-byte identical to the step-0 row: the assembled request the
model actually saw — the transcript, the tool results folded in, the notebook suffix, the cache
breakpoints — is captured nowhere.

**This is real debt whose cost grows with every driver call recorded from here on**, the same
shape as 2.1: a row written today with `capture_policy = 'full'` cannot later be backfilled with
the request it silently failed to capture, because that request was never durable anywhere else
either. Every multi-step turn recorded between now and the fix is a permanent gap in the eval and
fine-tuning corpora §7 promises.

**No migration for this in the final-fix-report wave that found it** — the schema has no column
for "the full assembled request", and adding one is exactly the kind of schema change that wave
was scoped to avoid. **Fix:** add a `request_shape` (or similarly named) `jsonb` column and write
the actual `buildRequest(args)` payload (redacted the same way `response` is) rather than deriving
`user_prompt` from the transcript after the fact.

**This was the drift monitor's blocker — the drift monitor (§7's "nightly golden-prompt canary,
fingerprinted and diffed") is now unblocked**, for the seats that write `request_shape`. See 2.5
below for a scoping gap this raises for the cheap seats specifically.

### 2.4 `tool_results` growth is now unbounded
Migration 0011 (2.1, above) made `tool_results` append-only, which is correct per spec §6 — but
append-only with no reaper means the table only grows. §6 says these rows are retained *at least*
as long as `model_calls` (90 days).

**Verified against the live database before writing this:** neither `tool_results` nor
`model_calls` has a retention job. `pg_cron`'s `cron.job` catalog is not installed in this
database at all (`cron.job` does not exist), and a search of `pg_proc` for any function named
`%reap%`, `%retention%`, `%purge%`, or `%prune%` returns nothing. There is no scheduled or
callable reaper for either table, anywhere in the schema. The 0011 migration comment says the same
and is accurate.

**Cheap today, not free going forward.** As of this pass, live row counts are `tool_results = 0`,
`model_calls = 1` (the one live demo turn noted in the plan's own self-review) — the blast radius
right now is zero. That will stop being true once slice 2 starts replaying and 3b's `revise_component`
starts issuing more supplier calls per turn. Size a reaper (or an explicit "no reaper, and here is
why the growth is acceptable" decision) before then.

### 2.5 `model_calls.request_shape` is NULL for every pre-0012 row, and for every truncated cheap-seat row
Migration 0012 (2.3, above) added the column but could not populate it retroactively, and its own
write path (`src/repo/modelCalls.ts`, `capturePolicyFor`) deliberately skips it a second way: any
row whose `capture_policy` is `'truncated'` also stores `request_shape = NULL`, by design, to avoid
a second, large copy of a request already deemed too big to store whole. `capturePolicyFor` can
only return `'truncated'` for the seats that are not `driver`, `front_desk`, or `reviewer` — those
three are hardcoded `'full'` always — so in practice this means any of the four cheap seats
(`scout`, `monitor`, `titler`, `sim_user`) whose combined system+user bytes exceed the 8KB
(`TRUNCATE_ABOVE_BYTES`) threshold.

**Neither gap is backfillable.** The pre-0012 rows describe requests that were never durable
anywhere else; a `'truncated'` row's assembled request was, by construction, too large to keep.

**Any consumer must treat `request_shape IS NULL` as "unknown", never as "no request".** The
column has no `NOT NULL` constraint specifically so this distinction is representable — collapsing
NULL to "no request happened" would misread both a pre-migration row and a legitimately
size-capped one as evidence of nothing, when in both cases a request did happen.

**Open question flagged for the next plan, not a defect in this one:** spec §7's drift sentence —
*"We also record the full request shape, because a silent provider-side change to a default is now
as likely a drift vector as a weights change"* — sits in the "Models, drift, and caching"
subsection, which covers all three seats (`driver`, `reviewer`, `cheap`), not the driver alone. But
`request_shape` is NULL on every truncated cheap-seat row by design (this item, above). If a future
drift monitor is specified to sample cheap-seat requests for comparison, it would have nothing to
diff against for any cheap-seat call over 8KB. The next plan needs to decide, explicitly, whether
the drift monitor's cheap-seat coverage is scoped to under-threshold requests only, whether cheap
seats need a lighter-weight shape capture that survives truncation, or whether drift detection on
the cheap seats is out of scope entirely — the spec as written does not say which.

---

## Tier 3 — latent, cheap, no cost while waiting

| # | Item | Notes |
|---|---|---|
| 3.1 | `messages.turn_id` and `agent_events.turn_id` unindexed | Plan 1's migration 0001. Pinned as the exact known exceptions by a catalogue test, so a *new* one fails a test. Indexing them turns that test red until the exception list is shortened — expected, and documented at the test. |
| 3.2 | The FK-audit query does not filter `indisvalid` or exclude partial indexes | A future FK child column whose only leading-column index is partial would pass the audit while not serving a parent-side delete. No such case exists today. Two predicates. |
| 3.3 | Kiwi refuses an entire response for one unusable price | `src/supplier/kiwi.ts`. SearchApi *skips* the offending property; Kiwi throws for the whole search. Fail-closed and consistent with the file's own treatment of a non-finite price, but a larger blast radius than a `continue`. |
| 3.4 | `quantity` is enforced as `=== 1` rather than data-driven | Correct for every shipped supplier (both price the whole booking). The first genuine per-unit supplier fails loudly with an explicit message rather than mispricing — so this is a carry-forward, not a trap. Revisit only when such a supplier appears. |
| 3.5 | No test pins that the global spend sum is restricted to the current day — **CLEARED by `d34ea61`** | Both writes land today, so a dropped `day` filter passes vacuously. Insert a `day - 1` row and assert it is excluded. `d34ea61` restored the `where day = (now() at time zone 'utc')::date` predicate on the global sum (`src/repo/spend.ts`) and added a test (`test/spend.test.ts`) that plants a large spend on a prior day for a different user and asserts the global read excludes it as a delta — confirmed to discriminate: with the filter removed, the planted amount leaked into the global total. |
| 3.6 | `search_params` is stored but never surfaced — **CLEARED by `e26409a`** | `rehydrate` does not return it and `SupplierItem` has no field for it — yet §5's cashier is specified as "re-run the stored search params, find by native ID". Plan 3 or 4 needs a reader. `e26409a` adds `search_params` to `rehydrate`'s returned `StoredItem`, null (not `{}`) when no real search was recorded. **This was the cashier's blocker — the cashier re-quote path is now unblocked.** |
| 3.7 | `rehydrateGate` echoes a raw `sourceId` into a violation `detail` — **CLEARED by `d34ea61`** | `src/gates/rehydrateGate.ts`. Plan 3 sanitised the two `propose_itinerary` interpolation points (`sanitizeSourceId`, `src/agents/driver.ts`) but not this one, so a supplier-controlled id still reaches the model unescaped and uncapped through a gate violation. Same shape as the fixed surface, one function away; the fix is to route this interpolation through the same helper. Low reachability today (both shipped suppliers derive ids from their own responses), which is why it was Tier 3 and not Tier 2. `d34ea61` moves `sanitizeSourceId` to a new root-level `src/sanitize.ts` (not into `src/tools/validate.ts` as originally briefed — that would create an import cycle through `validate.ts` → `registry.ts` → `rehydrateGate.ts` → `validate.ts`) and routes `rehydrateGate.ts`'s interpolation through it. |

---

## Tier 4 — belongs to plan 4, do not pull forward

| Item | Why it waits |
|---|---|
| **RLS is enabled but bypassed** | The worker connects as table owner, so non-forced RLS is a no-op. There is no row-level isolation today, only "no other role can touch these tables". Forcing RLS needs real policies, which need a browser client — plan 4. **`0003_lockdown.sql` and `src/repo/spend.ts` carry a written warning** that a per-user policy on `daily_usage` would silently disable the global ceiling: the sum would return only the caller's rows, read far below the cap, and stop firing with no error and no failing test. That hazard cannot be tested from inside the owner privilege level, which is why it is a comment where the policy author will be looking. |
| **`netlify.toml` points at a build that does not exist** | Declares `command = "pnpm build"` and `publish = ".next"`; there is no `build` script and no Next.js in the repo. A deploy would fail today. Harmless until there is something to deploy — plan 4. |
| **The production entry point still runs `echoAgent`** | `netlify/functions/run-turn-background.mts:5,72`. Assessed during the final-fix-report wave and deliberately NOT wired: `makeDriver` needs a transport (straightforward — `scripts/demo.ts`'s `liveDriverScenario` shows the shape) and two suppliers. `KiwiSupplier` needs no key, but `SearchApiHotels` needs an API key (`GOOGLE_SEARCH_API` in `.env.local` — note the name does not match the class), which is **not** in `src/env.ts`'s `KEYS` list. `loadEnv` is all-or-nothing across every caller: adding the key there would force `netlify/functions/sweep.mts` — an unrelated function that never touches a supplier — to also require it, and there is no test harness for either Netlify function (`run-turn-background.mts`'s own header: "exercised only by manual/staging verification, never by `pnpm test`") to catch a wiring mistake before it ships. Harmless today for the same reason the `netlify.toml` item above is: nothing deploys. Whoever does this wave should extend `env.ts` with a supplier-specific optional key (not folded into the required `KEYS` list) rather than widening what every Netlify function must have set, and construct the transport/suppliers the way `liveDriverScenario` does. |
| **`gate_results` has no `user_id`** | Every sibling table has one. Under a per-user RLS policy this table needs an `EXISTS` join to `conversations` rather than a direct predicate. Expressible, so not a blocker; belongs with the policy work. |
| **`conversions` is empty by design** | Created with the join key because that is what cannot be added retroactively. Rows arrive months after a click. Nothing to do. |

---

## API drift found while scoping plan 3

Checked against the current API reference rather than assumed. Recording it here because the
spec predates some of it.

**The spec is correct and stays:** Haiku 4.5 is the **only** current model with a dated snapshot
(`claude-haiku-4-5-20251001`); every other current model has an alias and no snapshot. So §7's
strategy holds exactly — pin the dated ID on the high-volume seat, and use a behavioural canary
for the aliased Opus seats, because `response.model` echoes the alias verbatim and string
comparison detects nothing.

**What has moved since the spec was written**, all of which plan 3 must account for:

- **`budget_tokens` is removed on Opus 5** — sending it returns 400. Use `thinking: {type:
  "adaptive"}` with `output_config: {effort: ...}` (`low`…`max`). The spec's per-seat `effort` is
  already the right shape.
- **Thinking is on by default on Opus 5.** Omitting `thinking` runs adaptive.
- **Assistant prefill returns 400** on Opus 5. Use structured outputs or system instructions.
- **`stop_reason: "refusal"`** is a 200 with `stop_details` — see 0.2. Needs a `fail_reason`.
- **Server-side fallbacks** should be opted into by default on Opus 5.
- **Pricing for the cost ledger:** Opus 5 $5/$25 per MTok, Haiku 4.5 $1/$5, Sonnet 5 $2/$10.
  `src/pricing.ts` must carry the current numbers, and cache writes bill ~1.25× while reads bill
  ~0.1× — which is why `model_calls` splits `cache_creation_input_tokens` from
  `cache_read_input_tokens` rather than keeping one `cached_in` column.
- **Streaming is required for large `max_tokens`** to avoid HTTP timeouts.
- **Mid-conversation system messages** are supported on Opus 5 — appended to `messages[]` rather
  than editing top-level `system`, which preserves the cached prefix. This is the
  prompt-injection-safe operator channel, and it is a better fit for the front desk than the
  spec's original shape.
