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
| **`gate_results.round` has no uniqueness** | No unique constraint on `(conversation_id, proposal_id, round, gate)`. Two `runGates` calls in one turn that forget to increment `round` write two full seven-row sets and the fire-rate double-counts. Plan 3 wires the first caller — it must set `round` deliberately, and probably ship the constraint. |
| **Prompt caching structure** | Plan 1 corrected the breakpoint layout on paper; nothing implements it. Current constraints: max 4 breakpoints per request, ~1024-token minimum cacheable prefix, render order `tools` → `system` → `messages`. |

---

## Tier 2 — real debt, cost accrues while it waits

### 2.1 `tool_results` is not append-only
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

### 2.2 The `count ?? 0` ban has no enforcement
Spec §7 states "a lint rule enforces it". **There is no linter in the repo** — no ESLint config,
no lint script, no dependency. The ban on the banned pattern is a comment and reviewer attention.

This is a money guardrail: `count ?? 0` converts "I cannot confirm usage" into "zero spent",
disabling a ceiling at the moment it is needed. A stated enforcement mechanism that does not
exist is worse than an acknowledged convention, because everything downstream assumes it holds.

**Fix:** add ESLint with a `no-restricted-syntax` rule matching `?? 0` on a spend read, or delete
the claim from the spec. Either is honest; the current state is not.

### 2.3 `model_calls` cannot reconstruct a driver call, though `capture_policy` says `full`
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

---

## Tier 3 — latent, cheap, no cost while waiting

| # | Item | Notes |
|---|---|---|
| 3.1 | `messages.turn_id` and `agent_events.turn_id` unindexed | Plan 1's migration 0001. Pinned as the exact known exceptions by a catalogue test, so a *new* one fails a test. Indexing them turns that test red until the exception list is shortened — expected, and documented at the test. |
| 3.2 | The FK-audit query does not filter `indisvalid` or exclude partial indexes | A future FK child column whose only leading-column index is partial would pass the audit while not serving a parent-side delete. No such case exists today. Two predicates. |
| 3.3 | Kiwi refuses an entire response for one unusable price | `src/supplier/kiwi.ts`. SearchApi *skips* the offending property; Kiwi throws for the whole search. Fail-closed and consistent with the file's own treatment of a non-finite price, but a larger blast radius than a `continue`. |
| 3.4 | `quantity` is enforced as `=== 1` rather than data-driven | Correct for every shipped supplier (both price the whole booking). The first genuine per-unit supplier fails loudly with an explicit message rather than mispricing — so this is a carry-forward, not a trap. Revisit only when such a supplier appears. |
| 3.5 | No test pins that the global spend sum is restricted to the current day | Both writes land today, so a dropped `day` filter passes vacuously. Insert a `day - 1` row and assert it is excluded. |
| 3.6 | `search_params` is stored but never surfaced | `rehydrate` does not return it and `SupplierItem` has no field for it — yet §5's cashier is specified as "re-run the stored search params, find by native ID". Plan 3 or 4 needs a reader. |

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
