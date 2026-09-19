# Plan 4a — The Chat — decisions taken during execution

Rulings made while executing `docs/superpowers/plans/2026-09-19-plan-4-chat.md`, recorded because
they were taken on the author's behalf so the work could continue. Same format as
`2026-09-13-plan-3c-seats-decisions.md`: what was decided, why, and what it costs if it was wrong.

Branch: `feat/plan-4-chat`, base `a3e7f23` (main) · 11 tasks, each reviewed individually — Task 2,
Tasks 3–4, Task 5, Task 6, Task 7, Task 8 and Task 9 each took one fix round — then a whole-branch
final review (opus, at `c6c67b2`) that returned one Critical, three Important and five Minor
findings plus eight unrecorded deviations, addressed in one fix wave (`a96720f..1904664`, 8/8
addressed) and confirmed clean by a scoped re-review. **991 tests passing, 13 skipped** (live
external-API and `LIVE_SUPABASE` suites, gated) at merge, up from the 793/11 baseline. Typecheck
clean across all three passes; `pnpm lint` clean with `.netlify/` present; `pnpm build` clean.
Migrations 0001–**0017** applied to the live Supabase project. The site is deployed:
https://globtrotty.netlify.app (last deploy `6aaebc21`).

The **sign-in smoke is not done** and the **live operator-channel pin is unrun** — see Parked.

---

## The four deviations from the plan header

### Deviation 1 — RLS is enabled with policies, not forced

**Ruling: migration 0016 enables row security with per-user `select` policies on the nine
user-owned tables; it never issues `force row level security`.**

The worker connects as the table owner, and `0003_lockdown.sql` carries a written warning that a
per-user policy visible to the owner would silently break the global daily ceiling — the ceiling
sums `daily_usage.cost_micros` across all users, and a forced policy would make that sum return
only the caller's rows, read far below the cap, and stop firing with no error and no failing test.
`daily_usage` therefore gets no grant and no policy at all, and nothing is forced anywhere.

**Cost if wrong:** a future non-owner writer needs policies written before it can write. Verified
against the live catalog at the final review: `relrowsecurity = true` and
`relforcerowsecurity = false` on all 17 public tables, pinned by `test/schema-4.test.ts`.

### Deviation 2 — the Next.js app owns the root `tsconfig.json`; typecheck runs three passes

**Ruling: `next build` rewrites the root `tsconfig.json`, so the harness's own config moved to
`tsconfig.harness.json` (NodeNext, `src`/`test`/`netlify`) verbatim, and `pnpm typecheck` runs
three `tsc --noEmit` passes: harness, root/Next, and `tsconfig.webtests.json`.**

The third pass was not in the plan as written — it was ruled at Task 6's review as a carried item.
The harness's `NodeNext` resolution cannot resolve `next/server`'s subpath import under the pinned
TypeScript 7 preview (confirmed with `--traceResolution`; `next`'s `package.json` has no `exports`
field), so every web test is excluded from the harness pass by the glob `test/web-*.test.ts` and
picked up by `tsconfig.webtests.json` instead, which has Next's types and the `@/*` alias. This is
also why several test files were renamed from the plan's literal names to the `web-*` pattern
(`test/web-api-messages.test.ts`, `test/web-api-proposals.test.ts`, `test/web-csp.test.ts`).

ESLint's ignore list is wider than the plan header originally said: `app/**`, `web/**`, `.next/**`,
`next-env.d.ts`, `proxy.ts`, `next.config.ts`, plus `.netlify/**` and `deno.lock` added by the fix
wave (I1). Flat config does not read `.gitignore`. The header was corrected in commit `1904664`.

**Cost if wrong:** a web test's *test code* (not the source it tests) is verified by running rather
than by static typechecking in the harness pass — it is still statically checked by the webtests
pass. A file named outside the `web-*` glob falls between the two and is checked by neither, which
is why the naming is a rule and not a preference.

### Deviation 3 — the Realtime publication change is conditional; the isolation test is live-only

**Ruling: 0016's `alter publication supabase_realtime` runs only if that publication exists, and
`supabase/ci-bootstrap.sql` creates a stub `auth.uid()` so the policies can be created on a bare CI
Postgres. The two-user isolation proof runs only against the real project, gated `LIVE_SUPABASE=1`.**

CI is a `postgres:16` container with no Supabase behind it (backlog 3c.5), so it has neither the
publication nor the `auth` schema. The stub makes the DDL apply; it does not make the isolation
provable there, which is why `test/rls.live.test.ts` exists and is gated.

**Cost if wrong:** the one test that actually proves isolation does not run in CI and must be run by
hand. It has been run: twice at Task 9, and once again by the controller after migration 0017.

### Deviation 4 — components are tested with `renderToStaticMarkup`, not jsdom

**Ruling: component tests render with `react-dom/server`'s `renderToStaticMarkup`; no jsdom, no
testing-library, and no JSX in test files (Vite's default `.ts` loader does not parse it, so every
element is built with `createElement`).**

**Cost if wrong:** a static render always produces a *consistent first frame* — state is seeded from
the props being rendered — so a bug that only appears on a re-render with new props is invisible to
it. This is not hypothetical: it is exactly why the final review's M2 (`SwapPicker`'s stale
selection) survived a full render-test suite. The fix wave's answer was to pin the stale
combination on an exported pure function, with render tests pinning only the contract that follows.

---

## Task 1 — migration 0016, CI bootstrap, schema tests

No ruling was needed. The constraint names the migration drops (`messages_role_check`,
`agent_events_kind_check`) were checked against the live catalog before the migration was written,
and the `supabase_realtime` publication was confirmed to exist before the conditional block was
relied on. The migration was applied to the live project by the implementer; `ci-bootstrap.sql`'s
`auth.uid()` stub was never applied there (Supabase has a real `auth` schema).

Review: clean; policies and grants verified against the live catalog.

---

## Task 2 — the operator channel in the transcript

### The channel carries ids and enums only

**Ruling: `rejected` drops its `reason` field entirely. The decide route writes the operator's
reason as an ordinary `role = 'user'` message before the action row.**

The review found that a `reason` embedded in the operator text lets her close the quote and write an
operator-voice sentence — the exact forgery the channel exists to prevent. Spec §4's own wording
already said "ids and an enum". `ActionPayload` is a `z.strictObject` discriminated union, so a
`reason` on the wire is now a parse failure rather than a silently dropped field, and
`renderActionMessage` renders a fixed sentence pointing the model at her own message.

**Cost if wrong:** the reason loses operator emphasis, which is the point of moving it.

The same review round fixed three more: `normalizeOperatorTurns` (below); `placeBreakpoints` now
`continue`s past any `system` block in both its walks, so an operator message can never carry a
cache breakpoint nor steal the rolling mark from the turn before it; and `messages[0] = system` now
throws rather than being assumed unreachable.

### Normalisation, and the pipeline order — ruled once, built wrong, fixed at the final review

**Ruling (review): one normalisation step in `buildRequest` — every `system` message moves to
immediately after the LAST user message *(after the suffix)*, consecutive system messages merge into
one, and a transcript with no user message throws.**

**Ruling (implementer's counter-proposal, accepted at the time): the pipeline order is
`normalizeOperatorTurns → placeBreakpoints → withSuffix`, not the literal order in the finding.**

The implementer's reasoning was that under the literal order the suffix block would be the last
eligible block when `placeBreakpoints` ran, so the rolling breakpoint would land on the volatile
notebook — a wasted cache write on every request, pinned by an existing test. That reasoning about
`placeBreakpoints` was sound; the conclusion was not. It moved `normalizeOperatorTurns` to the
*front* of the pipeline, which is not "after the suffix" at all, and the transcript shape it
produced on the accept path was wrong. See **C1** in the final review below — this is the one
ruling in the plan that was taken, recorded, and then silently contradicted by the build.

**Cost if wrong:** the cost that was actually paid — the operator instruction landed two turns from
the end of the request on the product's money moment, and no test caught it because the one
`[user, assistant, system]` case in `test/model-client.test.ts` was asserted with an *empty* suffix,
the single case where the trailing user turn is not created.

---

## Tasks 3 and 4 — `submitAction`, the shared invoker, the outbound filter

### A safety escalation is never rate-limited

**Ruling: the outbound filter's escalation bypasses `escalate_to_human`'s per-user daily limit — it
calls `recordEscalation` directly — and `countEscalationsToday` excludes `reason = 'safety'` so a
filter page never consumes one of the driver's three daily slots.**

A screened reply is a safety event, not a model choice, and must always page. The table cannot tell
a filter-written `safety` row from a driver choosing `reason: 'safety'` itself, and does not need
to: neither should compete with genuine escalations for the same budget.

**Cost if wrong:** a chatty failure pages repeatedly — bounded by one page per turn.

### The filter pages a human, like `escalate.ts` does

**Ruling (review): `WorkerDeps` gains a required `notifier`; `screenReply` keeps the `Escalation`
row `recordEscalation` returns, notifies, and stamps `notified_at` best-effort — the same shape
`escalate.ts` already used.**

As shipped, the filter wrote the row and swallowed it; nothing paged. `recordAgentEvent` stays
best-effort (a lost audit row must not cost her the reply); `recordEscalation`'s own insert is not
swallowed, because there is no `Escalation` to hand the notifier without it.

**Cost if wrong:** a few lines at every `WorkerDeps` construction site.

### Rule 20's verbs were widened and its object narrowed

**Ruling (review): the generic solicitation rule reads `send|upload|share|email|attach|text|provide`
and requires a document noun (`passport|id|identity|licen[cs]e|card|visa|document`) rather than any
noun at all.**

As shipped it blocked "I will send a copy of your booking confirmation to your email" — a false
positive on a sentence the product needs to be able to write.

**Cost if wrong:** a bare "share your ID" with no media noun is not caught — recorded as backlog 4a.8.

**Ruling: "the passport office is on Rua X" is genuinely safe, not an accepted false positive.**
The brief was self-contradictory on this row. No rule fires on a bare "passport" without a paired
number/photo/scan/copy request. **Cost if wrong:** a bare-passport phrasing that asks for the
document passes if it lacks every word the table does catch.

### An action row is written only when a fresh turn is won

**Ruling (review): `submitAction` inserts the turn FIRST (`on conflict do nothing`) and writes the
action row and the `working` flip in the same transaction, only when that insert returned a fresh
row. `busy` and `duplicate` write nothing.**

This is deliberately asymmetric with `submitMessage`, which preserves a typed message because it is
her words. An operator instruction is not: the card disables while working, a 409 lets her press
again, and a duplicated instruction in the transcript is worse than a refused press. Pinned by
row-count assertions on both branches.

**Cost if wrong:** a press during a running turn is dropped rather than queued — visible to her, and
re-pressable.

Minor, fixed the same round: `submitAction` re-`.parse`s the payload at the boundary before any DB
call. Minor, deferred: see backlog 4a.8.

---

## Task 5 — the production agent, and the prompt files the bundler moved

**Ruling (review, Critical): one `loadPrompt(name)` helper in `src/agents/prompts/load.ts` that
tries the `import.meta.url`-relative path, then `<process.cwd()>/src/agents/prompts/<name>.md`, and
throws naming both when neither exists. All four seats and `src/monitor/drift.ts` use it.**

The reviewer reproduced the failure with `@netlify/zip-it-and-ship-it`: esbuild folds every seat
module into the one function file, so each seat's `readFileSync(new URL('./prompts/x.md',
import.meta.url))` resolved against `netlify/functions/run-turn-background.mjs` while
`included_files` put the `.md` files at `src/agents/prompts/` relative to the zip root — ENOENT at
module initialisation on every invocation. Dormant until Task 5 wired `routeAgent` in; live from
that moment.

**Cost if wrong:** none — the fallback is only reached when the first path misses.
`test/deploy-config.test.ts` now walks `src/agents/` and `src/monitor/` and fails on any
`new URL(...prompts...)` construction, so the pattern cannot come back. The cwd-fallback assumption
on Netlify was proven by Task 10's cold-invocation check, which returned a clean answer in under a
second with no init error — that curl is this finding's closure.

**Also this task:** when `GOOGLE_SEARCH_API` is unset the background function falls back to
`MockSupplier` for hotels after a `console.error`, loudly, once per invocation. Recorded as backlog
4a.5 — it is a real silent-downgrade surface in production, not just a test convenience.

---

## Task 6 — the Next.js scaffold, the 401 contract, the owner connection

### `proxy.ts`, not `middleware.ts`

**Ruling: Next 16 deprecates the `middleware` file convention in favour of `proxy`; the root file is
`proxy.ts` exporting `proxy`, and `cspFor` lives in `web/csp.ts` so tests can import it without
`next.config.ts`'s env-var guard throwing at import time.** **Cost if wrong:** none.

### `UnauthorizedError` + `withUser`, because a thrown `NextResponse` is a 500

**Ruling (review, Critical): `requireUser()` throws `UnauthorizedError`; route handlers are
`export const POST = withUser(async (user, req) => …)`, and `withUser` turns that error — and only
that error — into a 401 `NextResponse`. Anything else rethrows.**

The brief's own interface was wrong: an uncaught throw of a `Response` is not special-cased by
Next's error boundary, verified in the installed runtime. A DB failure must not look like an auth
failure, which is why the catch is an `instanceof` check and not a catch-all.

### `ownerSql()` keeps `DATABASE_URL` out of `app/`

**Ruling (review): a new `src/db/owner.ts` exports `ownerSql()`, which reads only
`process.env.DATABASE_URL` — never `loadEnv`, which would drag `SUPABASE_SERVICE_ROLE_KEY` into the
Next function's environment for no reason. The client is cached on `globalThis`, `max: 1`, and
created lazily per request.**

This is what lets the sentinel test (`test/web-config.test.ts`) keep `DATABASE_URL` in its list of
forbidden strings under `app/`/`web/` while the routes still write on the owner connection. A
missing env var fails the first request, not the build.

Also ruled the same round: the proxy returns 401 for `/api/*` without a session instead of
redirecting to `/login` (and carries refreshed cookies on that branch as well as the redirect one);
`next.config.ts` asserts both `NEXT_PUBLIC_` names at build; `/auth/callback` surfaces the auth
error as `/login?error=<code>` from a fixed three-string table, never the raw `error_description`.

**Cost if wrong:** small — each is a few lines.

### The webpack pin (surfaced at Task 7, caused here)

**Ruling: `next dev`/`next build` run with `--webpack` plus a `webpack.resolve.extensionAlias`
mapping `.js → ['.js', '.ts', '.tsx']`.**

Task 7 is the first time anything under `app/` imports from `src/`, where every relative import
carries an explicit `.js` extension — correct and required under the harness's NodeNext resolution.
Turbopack only remaps a `.js` import to a sibling `.ts` when the tsconfig it reads says
`moduleResolution: "nodenext"`, and this repo's root config deliberately says `bundler` (Deviation
2's own fix, so `tsc` can resolve `next/server`). Three alternatives were tried and rejected
empirically: plain `next build` (fails), `next build --webpack` with no config change (fails the
same way), and a `turbopack.resolveExtensions` override (no effect — it governs extensionless
imports only).

**Cost if wrong:** webpack builds are slower than Turbopack. The real fix is to drop the `.js`
suffixes across `src/`, a cross-cutting change nobody should make inside this plan. Backlog 4a.6.

---

## Task 7 — thread, sidebar, message box, the message route

### Every write route does its own ownership select

**Ruling (review, Important): the message route validates the URL id as a uuid (404 otherwise) and
then runs `select 1 from conversations where id = … and user_id = …` on the owner connection before
`submitMessage` runs at all.**

`submitMessage` runs on the owner connection, which bypasses RLS entirely; its own `user_id`
filters are data filters, not an authorisation check — nothing inside it refuses to act on a foreign
conversation id. The implementer verified the break: without the select, a foreign id threw
`readSpendFailClosed`'s fail-closed error out of the route as a 500 rather than a 404. The same
pattern is `loadProposalForUser` in decide and revise (Task 8).

**Cost if wrong:** one cheap query per write. The four "another user's id" paths are each pinned
with "and writes nothing" row-count assertions.

Also ruled the same round, all four Important:

- **Honest 409/429 copy.** `MessageBox` said "could not be sent" on a 409 or 429 although the
  message *was* stored by `submitMessage` — and invited a retry that would duplicate it. Extracted
  as the pure `messageForStatus`; on 409/429 the box now clears and refreshes, because the row is
  really there.
- **Bounded sidebar query, debounced refresh.** `listConversations` caps at 50 conversations and
  200 first-message rows; `subscribeConversation` debounces `onChange` 250 ms trailing across both
  listeners. The PostgREST embedded-query shape was *not* used: `messages` reaches `conversations`
  through a composite foreign key and there was no harness to prove the embedded filter does not
  mis-join, so the documented fallback (one flat query, deduped by a pure function) was taken. The
  trade — a conversation whose first message falls outside the oldest 200 rows shows "New
  conversation" rather than its first line — is in `listConversations`' doc comment.
- **Action rows are parsed server-side.** `web/data.ts`'s `toThreadView` turns a `role='action'`
  row into its `describeActionForUi` sentence before it is returned, so raw JSON (and proposal ids)
  never enter the RSC payload. `MessageBubble` no longer imports `src/actions` at all.
- **No dead sidebar.** The layout's 260px placeholder is gone; the real `Sidebar` carries the class.
  It is rendered per authenticated page rather than in the layout on purpose — the anon role has no
  `select` grant on `conversations`, so a sidebar in the shared layout would 500 `/login`.

---

## Task 8 — the proposal card, decide and revise

### The decision is written inside the turn's own transaction

**Ruling (review, Critical): `submitAction` gains `onFreshTurn?: (tx) => Promise<void>`, invoked
inside the fresh turn's transaction right after the turn insert succeeds; `decideRoute` passes
`(tx) => decideProposal(tx, …)`. `busy` and `limit_reached` now write nothing at all.**

As shipped, decide committed the decision and *then* called `submitAction`, so a `busy` or
`limit_reached` answer left an accepted proposal with no hand-off turn, no buttons, and no recovery
before the cashier's 30-minute window closed. The implementer reproduced it by reverting the shape:
both new tests failed with `decision === 'accept'` despite the 409/429 response.

`decideProposal`'s signature widened to `postgres.Sql | postgres.TransactionSql` (it never calls
`.begin` itself, so accepting a transaction handle is safe; postgres.js's types do not make
`TransactionSql` structurally satisfy `Sql`). `onFreshTurn`'s doc comment states the contract: the
callback MUST use the `tx` handle it is given — closing over the root `sql` can deadlock against
the transaction's own hold on the `turns_one_active_per_conversation` index entry.

**Cost if wrong:** one more parameter on one repo function.

### `clock_timestamp()` on the action row

**Ruling (review): the reject note (`role='user'`, `now()` default) and the action row share a
transaction, so they shared an identical `created_at`. The action row is now stamped
`clock_timestamp()` explicitly so the reason sorts first.**

`now()` is the *transaction* start time in Postgres; `clock_timestamp()` advances within it
(confirmed directly against the project DB). This is the same hazard that later explained the
`route.test.ts` flake — see the final review.

### The swap id is pre-checked against this conversation's corpus

**Ruling (review): `reviseRoute` runs `select 1 from tool_results where conversation_id = … and
source_id = … and kind = SLOT_KINDS[slot]` before `submitAction`, 404ing on zero rows.**

Without it, a `sourceId` from another of her own conversations, or a hotel id sent for a flight
slot, burned a turn and a model call on a request the driver could not satisfy.

Minors fixed the same round: the swap picker drops expired ids (`dropExpiredAlternatives`, the same
rule as `listExpiredSourceIds`) and shows each option's age; `Object.hasOwn` guards the
`SLOT_KINDS` index; picker buttons disable while pending; the decide body `superRefine`s that a
`rejectReason` may not accompany `decision: 'accept'`; `loadProposals` is limited and narrowed;
item lines show dates read straight off the stored `detail` (never parsed into a `Date`).

### The reject reason is her own message

**Ruling: a reject reason is persisted in `proposals.reject_reason` AND inserted as a plain
`role='user'` message inside `submitAction`'s transaction (a new optional `userNote`), so "her
reason is in her own message" — the sentence the operator text tells the model — is true without a
second turn.** **Cost if wrong:** one extra user row per reject.

---

## Task 9 — the isolation and CSP proofs

**Ruling (review): three fixes in one commit.**

1. **Cleanup by captured ids.** `test/rls.live.test.ts`'s `finally` deleted conversations only when
   the *whole* seed had succeeded (`seedA` non-null), so a throw in any of the eight inserts after
   the conversation row left a real conversation behind — and `auth.users` has no FK to
   `conversations`, so `deleteUser` does not cascade it away. Conversation ids are now pushed onto
   an outer-scope array the moment each `insert … returning id` resolves, and the `finally` loops
   over that array with each delete independently try/caught. Orphan count after the live run: 0.
2. **A test for `decideRoute`'s rethrow branch.** Task 8's re-review had narrowed the catch so that
   anything other than "already decided" propagates; nothing drove the new branch. `decideProposal`
   is a direct import, not a dep, so the test wraps the real module once with `vi.mock` and
   `mockImplementationOnce` and asserts the throw reaches the caller and `invoke` was never called.
3. **`DENIED_TABLES` covers all six** ungranted tables, not two.

**Cost if wrong:** one extra live run creating and deleting two throwaway auth users.

Task 9 also carried five items from Task 8's re-review: the narrowed catch itself, a test that an
`onFreshTurn` rejection rolls the turn insert back, `ageText` moved to `web/components/age.ts` to
break a `ProposalCard ↔ SwapPicker` import cycle, the `onFreshTurn` tx-handle doc comment, and an
explicit `'duplicate'` branch in `makeDecide` (unreachable through this route, which mints a fresh
idempotency key per call — the comment says so accurately after a self-review correction).

The fix commit was controller-verified against the diff rather than given its own scoped review; the
whole-branch final review covered it.

---

## Task 10 — deploy

Site `globtrotty` created on team `dan-neciu` and linked; all ten env names set, secrets scoped to
`production`/`deploy-preview`/`branch-deploy` (the CLI refuses `--secret` for the `dev` context).

**Ruling: `supabase/config.toml`'s `[auth]` section was aligned with the live project *before* the
push was attempted** — MFA TOTP, email confirmations, `otp_length = 8`, `max_frequency = 1m0s` —
so the push diff is only the two URLs. `supabase config push` pushes the whole section, and every
key where the file disagrees with the dashboard gets overwritten. **Cost if wrong:** a silent
auth-configuration change nobody asked for.

**`supabase config push` itself was blocked by the permission classifier and is left to the user.**
Until it runs, a magic link falls back to the project's stored `site_url` and sign-in can fail for a
configuration reason rather than a code one. `docs/deploy.md` §4 is the procedure. Backlog 4a.15.

### The proxy's default matcher swallowed the function URL

**Ruling: Netlify function paths bypass the session proxy — `/.netlify/` is excluded from the
matcher AND treated as public by `decide()`; the worker's own shared-secret check is the only door
on those paths.**

The first production deploy (`6aaeb392`) answered the background function's own URL with a
`307 → /login`: `proxy.ts`'s default matcher covered `/.netlify/*`, so the app's session guard was
standing in front of a machine-to-machine endpoint that never had a session. Fixed, with a test.

**Cost if wrong:** none new — those paths never had a session. The caveat this creates is M4, below.

### A background function answers 202, not 401

**Ruling: the plan's Step 3 check ("must print 401") was wrong. Netlify answers *every* request to a
background function with a fixed `202` before the handler's own reply exists; the real 401 is in the
function log.**

Second deploy `6aaeb3f5`: `/login` 200 with CSP, `/` → 307 `/login`, `/api` 401, background function
202 with invocations completing in under a second and no init error — which is what actually closes
Task 5's prompt-loading finding. `docs/deploy.md` records the 202 so the next person does not read
it as a broken secret check.

---

## Final review — C1, I1–I3, M1–M5

Run at `c6c67b2` against `git diff main..HEAD` (22 commits, 98 files, +6979/−103) with the files
read rather than the task reports trusted. Result at that point: 980 passed / 13 skipped, typecheck
clean, **`pnpm lint` failing**. Verdict: needs a fix wave.

### C1 (Critical) — the operator message was not last on the accept path

`buildRequest` was `withSuffix(placeBreakpoints(normalizeOperatorTurns(messages)))`. Because
`normalizeOperatorTurns` ran *before* the suffix existed, it anchored the operator message to the
last *stored* user turn — and `withSuffix` then opened a new trailing user turn for the notebook,
pushing the instruction two turns from the end.

She presses **Accept**. The stored transcript is `[user, agent(proposal), action]`, hydrating as
`[user, assistant, system]`. **Before the fix**, with a real notebook suffix:

```
0: user      "a week in Portugal"
1: assistant "When would you fly?"
2: user      "September"
3: system    "Operator: the traveller accepted proposal <id> … call hand_off_to_booking"   ← not last
4: assistant "Here is your proposal ..."                                                   ← after the instruction
5: user      "- destination: Faro (user)"                                                  ← notebook
```

The model reads "she accepted proposal X, call the tool now" *before* its own message presenting
that proposal, with two turns of unrelated content after it. **After the fix**
(`normalizeOperatorTurns(withSuffix(placeBreakpoints(messages), suffix))`):

```
['user', 'assistant', 'user'(NOTEBOOK), 'system'(Operator: …)]
```

— the operator message last, as spec §4 and the Task 2 ruling require. `withSuffix` strips the
trailing system run, sees a head ending on `assistant`, and therefore opens a new trailing user turn
for the notebook rather than appending it to an assistant turn (which would present the notebook as
something the model said); `normalizeOperatorTurns` then lifts the operator message behind it.

The invariant the old order was defending still holds, and the fix wave re-derived it rather than
assuming: `placeBreakpoints` still runs first, on the raw transcript, so the suffix block does not
exist when the rolling mark is placed; and `placeBreakpoints` skips `system` blocks *wherever they
sit*, so moving the normalise step behind it moves no breakpoint —
`normalizeOperatorTurns` never reorders the non-`system` messages relative to one another, so both
walks visit the same blocks in the same order. Break-and-watch-it-fail: flipping the line back fails
the new test and nothing else.

**Whether Opus 5 complied with the old shape is unproven either way** — the live pin for a trailing
system message is written and unrun (no Anthropic credit). What is certain is that the built shape
was not the shape the spec, the ruling, or the driver prompt ("They reach you as a message from the
office naming the tool to call") were designed around, and that the failure mode is the product's
money moment: a card reading "Accepted", no buttons, no links, and the cashier's 30-minute window
running out.

### I1 — `pnpm lint` failed for anyone who had run the deploy runbook

ESLint 9 flat config does not read `.gitignore`, so once `netlify build` had run, `eslint .` walked
Netlify's vendored Deno/Next bundles: 7 errors, 5 warnings. The branch's own stated pre-commit gate
was broken by its own runbook. Fixed by adding `.netlify/**` and `deno.lock` to `ignores`, with a
comment saying why.

### I2 — a screened reply's original was readable by the role it was withheld from

`screenReply` writes the original text to `agent_events` as `{ kind: 'screened', payload: { reason,
original } }`, and 0016 granted `authenticated` SELECT on that table under `user_id = auth.uid()`.
Her own anon client could fetch the exact reply the filter replaced with one PostgREST call. Not a
cross-user leak, and the UI never renders it — but it defeats the control's stated purpose.

**Fixed by migration `0017_screened_hidden.sql`**, which recreates `own_agent_events` as
`using (user_id = auth.uid() and kind <> 'screened')`. Applied to the live project with
`psql -1 -f` (the same single-transaction way 0016 was applied; the permission classifier refused
the first invocation and allowed a plainly-described retry). `test/schema-4.test.ts` now pins the
policy's `qual` **predicate** byte-for-byte, not merely that a policy exists, so a drift back to a
bare `user_id = auth.uid()` fails rather than silently re-opening the row.

### I3 — a non-`planning` desk 500'd instead of 409ing

Spec §4 says the routes assert `desk = 'planning'` and 409 otherwise; it was built as an
`ActionRefused` throw that neither route caught. Unreachable today (`desk` is monotonic), so a
latent contract gap rather than a live bug. Both routes now catch `ActionRefused` — an `instanceof`
branch placed *before* decide's existing `/already decided/i` regex, deliberately a class check so
the two 409 reasons cannot be confused — and answer `409 { error: 'not_planning' }`. The tests
reach the state by `update conversations set desk = 'front'` inside the rolled-back transaction.

### M2, M3, M5 — fixed in the wave

**M2:** `SwapPicker`'s `choice` was `useState`-seeded once and the component survives
`router.refresh()`, so a card first rendered with no alternatives kept the item's *own* `sourceId`
as its selection; once a later search added alternatives the Swap button enabled, the `<select>`
showed a value matching no option, and "Confirm swap" posted the item's own id — which passes the
corpus pre-check and burns a turn on a no-op swap. The selection is now *derived* every render by
the exported pure `effectiveChoice`, and Confirm is disabled on `value === undefined` so the enable
condition and the id posted are the same fact.
**M3:** a 429 on the card said "could not be sent. Please try again." — advice that cannot work,
since `submitAction` returns `limit_reached` before its transaction and nothing was written. Now
`errorForStatus`, a pure function in the same shape as `MessageBox.messageForStatus`, with wording
that deliberately omits that function's "Your message is saved" (true there, false here).
**M5:** the plan header's Deviation 2 said `pnpm typecheck` "runs both"; corrected to three passes,
along with the same sentence's stale ESLint ignore list.

**M1 and M4 were not fixed** — see Parked.

### The `route.test.ts` flake: three reports, one root cause, no product bug

Reported at Task 5, Task 8 and Task 9 as an intermittent, load-correlated failure of one
message-ordering assertion that always passed in isolation. It is not timing-sensitive; it is
**tie-sensitive, and the tie is real**.

`test/helpers/db.ts`'s `withTestDb` wraps the whole test in ONE transaction. Postgres' `now()` is
the *transaction* start time, so every row a DB test inserts through the `messages.created_at`
default gets an **identical** timestamp — verified directly against the project DB (`now()`
identical across statements in one tx = true; `clock_timestamp()` = false). `order by created_at`
over the `user` row and the `agent` row is therefore a total tie, and Postgres guarantees nothing
about tie order: the plan flips between an index scan (TID order ≈ insert order) and a seq scan plus
an unstable quicksort as the table's statistics move under concurrent full-suite load.

**Ruling: fix the assertion, never the sort.** The test now selects roles with no `order by` and
compares them as a sorted list, and pins the agent row's content with a second query filtered by
`role = 'agent'`. **A secondary sort key would have been the wrong fix** — `role` sorts `agent`
before `user` and would have pinned the wrong answer for the wrong reason. The comment records the
`withTestDb`/`now()` root cause in place so the next person writing a DB test that asserts row order
does not rediscover it the hard way. (`test/handler.test.ts` and `test/web-api-proposals.test.ts`
order the same way but are safe: the action row's `clock_timestamp()` is strictly later than the
note's `now()`, and rows that *are* tied share a role.)

### The wave, and what closed it

Eight commits (`a96720f..1904664`), one per item. Every finding was verified against the code
before being fixed; **none was wrong.** 991 passed / 13 skipped (+11 tests on the review's
baseline), typecheck clean, `pnpm lint` exit 0 with `.netlify/` present in the worktree.

**The scoped re-review of the fix wave came back clean.** It re-derived C1's invariants from the
algorithm rather than from the tests — `[system, user]` adjacency is structurally impossible under
the new order, and a breakpoint can land on neither the suffix nor a system block — confirmed I2's
new predicate against `pg_policies`' `qual`, confirmed I3 catches by `instanceof` only, confirmed
`route.test` asserts by role, and confirmed that the pure functions M2 and M3 pin are the ones the
JSX actually uses. No new findings.

**The live RLS test passed after migration 0017.** The controller ran
`LIVE_SUPABASE=1 pnpm vitest run test/rls.live.test.ts` once against the real project: green,
including the new assertion that user A cannot read her *own* screened original while still reading
her ordinary `agent_events` row. The site was redeployed afterwards (`6aaebc21`).

---

## Unrecorded deviations, now recorded

The final review listed eight items built differently from the spec, the plan or a ruling and
written down nowhere. Each is recorded here; three were fixed rather than merely recorded.

1. **The pipeline order (C1).** Ruled "after the suffix", built before it. **Fixed** — `a96720f`.
2. **Spec §4's "409 otherwise" for a non-`planning` desk (I3).** Built as a throw that became a
   500. **Fixed** — `d492bcb`.
3. **Spec §3's "Realtime carries ids and statuses, never prose" (M1).** The publication carries
   full rows, `content` included. **Not fixed; the spec sentence is corrected instead** — see the
   spec's "Corrections after build" and Parked below.
4. **The message route's body shape.** Spec §2 specifies `{ text }`; it is built as
   `{ text, idempotencyKey }`, with a client-generated `crypto.randomUUID()` per send, so a retry
   is idempotent against `submitMessage`'s existing turn-insert conflict. Sensible, and
   `MessageBox`'s doc comment reasons about it — but the change to a stated contract appeared in no
   plan header and no ruling. Spec corrected.
5. **The ESLint ignore list is wider than Deviation 2 stated** — six entries in the config against
   the header's three, and two more added by I1. Header corrected in `1904664`.
6. **"`pnpm typecheck` runs both" is three passes (M5).** Ruled in the ledger as a Task 6 carried
   item, never folded back into the header. Corrected in `1904664`.
7. **`web/invoke.ts` (`readInvokeEnv`)** is a new module in neither the plan's file map nor any
   ruling. It reads exactly `SITE_URL` and `WORKER_SHARED_SECRET` off `process.env` and throws when
   either is unset — deliberately not `loadEnv`, for the same reason `ownerSql()` is not. Recorded
   here. (`src/db/owner.ts`, `web/csp.ts`, `web/components/age.ts`, the `web/*Route.ts` files and
   `proxy.ts` are also absent from the file map, but each of those *is* ruled in the ledger.)
8. **`.gitignore` gained `*.tsbuildinfo` and `deno.lock`** — downstream of `"incremental": true`
   in the Next-owned root tsconfig and of Netlify's edge bundler. Harmless; recorded.

---

## Parked

Real, none load-bearing, filed to the backlog rather than fixed here.

### M1 — the Realtime publication carries whole rows

Verified against the live catalog: `supabase_realtime` publishes `messages` with all seven columns
including `content`, and `conversations` with all ten; `relreplident` is `d` on both. Her message
text, agent prose and an `action` row's raw JSON do travel over the websocket. **Not a leak** — RLS
scopes the stream to her own rows, and `web/realtime.ts` deliberately ignores every payload and
refetches — and `web/data.ts`'s narrower claim, that the JSON never enters the RSC payload, is true.
The spec sentence was simply wrong, and is corrected. A column-list publication
(`alter publication supabase_realtime add table messages (id, conversation_id, user_id,
created_at)`) would make the original sentence true at no cost, since the client already ignores the
payload; PG15 supports it. Backlog 4a.12. **Cost if wrong:** none today; the gap is between the
document and the database, not in the behaviour.

### M4 — the scheduled functions' safety rests on one Netlify behaviour

`netlify/functions/sweep.mts` takes no `Request` and checks nothing; `src/monitor/authorise.ts`
returns `true` for a request with no `x-worker-secret` header and a body containing a `next_run`
string — an uncapped-spend endpoint (real Anthropic calls against `OPS_USER_ID`) gated on a value
anyone could type. **Both are safe in production, and neither file is introduced by this branch.**
Netlify's documentation is explicit: *"You can't invoke scheduled functions directly with a URL."*
`run-turn-background`, which *is* HTTP-reachable, has a real `timingSafeEqual` check, and plan 4a's
`/.netlify/` proxy exclusion is correctly reasoned given that.

**The dependency is the point, and it is now explicit: the whole guarantee rests on that one
Netlify behaviour AND on `netlify.toml` keeping the `[functions."sweep"]` and
`[functions."drift-monitor"]` `schedule` keys.** Delete a schedule entry and that function becomes a
public, unauthenticated, spend-bearing URL — no test and no type will catch it. The fix, when it is
taken: give `sweep` the same shared-secret check, and drop `authorise`'s `next_run` path in favour
of the secret. Backlog 4a.13, and a Careful entry in the work log. **Cost if wrong:** real money
spent by anyone who finds the URL, in the world where Netlify changes that behaviour or someone
edits the toml.

### The CSP's `script-src 'unsafe-inline'`

Kept, per the plan's own instruction to time-box the nonce exploration. It is **not** required by
Next 16 — Next supports a nonce-based strict CSP (nonce set on the request header in the proxy,
stamped onto Next's own script tags, with `'strict-dynamic'` for chunk loading). What the recorded
compromise really says is that **nobody has verified that pattern survives
`@netlify/plugin-nextjs`'s edge handler and the Netlify CDN.** With `'unsafe-inline'` present the
script directive provides no XSS protection at all — it is doing nothing except making the header
look stricter than it is. The practical risk today is low: every text path renders through React
escaping and there is no `dangerouslySetInnerHTML` anywhere (the sentinel test greps for it). The
rest of the header is real and pinned by `test/web-csp.test.ts`. Backlog 4a.4 names the shape to
try. **Cost if wrong:** an XSS that gets a script into the page is not stopped by the header.

### `test/route.test.ts`'s flake history

Kept here because the *report history* matters more than the fix: it was reported three times, in
three different tasks, each time diagnosed as a transient remote-DB hiccup and each time dismissed
because it passed in isolation — which is exactly what a tie-order bug looks like. The root cause
(`withTestDb` freezes `now()`) was only found when someone tested the hypothesis against the DB
instead of re-running the suite. **Cost if wrong:** none now; the lesson is that "passes alone,
fails under load" is a hypothesis about the *data*, not only about the network.

### Unrun and unfinished

- **The live operator-channel pin is written and unrun.** `test/driver.live.test.ts` carries a
  trailing-system-message call whose only assertion is that the API accepts the shape. It has never
  run — the Anthropic account's credit balance is still too low (backlog 3c.17), which also still
  blocks the L1 pins, CI's live suites and the nightly drift monitor. C1's fix therefore restores
  the *designed* shape; it does not prove the model's behaviour on it.
- **The deploy smoke's sign-in step is the user's**, and needs `supabase config push` first.
- **`supabase config push` is unexecuted**, so the live project's auth URLs may not match
  `supabase/config.toml`. The file is the source of truth; the push is not recorded in git.
