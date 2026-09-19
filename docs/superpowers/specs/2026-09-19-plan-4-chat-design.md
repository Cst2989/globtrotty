# Plan 4a — The chat: Next.js on Netlify, sign-in, row security, the proposal card

**Date:** 2026-09-19
**Status:** Approved for planning
**Parent spec:** `2026-08-15-globetrotty-design.md` (binding). This document narrows §6 (RLS), §7
(tiers 1–2), §9 (what she sees) and §10 (security) to one plan and records the rulings taken to do
so. Where the two disagree, the parent wins and this document is wrong.
**Scope:** everything needed for the author to sign in on a deployed site, ask for a trip, watch
the turn run, accept or revise a proposal, and receive tracked links — plus the row security the
browser client needs and the prompt-injection surfaces the UI opens. **Out (plan 4b):** token
streaming with the price redactor on deltas, GDPR endpoints, memory, per-component "shift dates"
UI beyond ±2, account management.

---

## 0. Facts that shape this plan

- Nothing has ever been deployed. `netlify.toml` declares `pnpm build` and `.next`; neither exists.
  The production entry point `netlify/functions/run-turn-background.mts` still runs `echoAgent`.
- The Netlify CLI is logged in as the author; no site is linked to this repo. The Supabase CLI is
  logged in and this folder is linked to project `fhqsiydgoqmwvihqsbap`. `.env.local` carries every
  key the functions need.
- `messages.role` is `user | agent`. `loop()` hydrates the transcript from that table on a fresh
  turn. `withSuffix` appends the volatile notebook to the last message when it is a user turn, else
  opens a new user turn.
- Opus 5 accepts mid-conversation `system` messages in `messages[]`: one must follow a user message
  (or an assistant message ending in server-tool use), must be the last entry or be followed by an
  assistant turn, and cannot be `messages[0]`. This is the operator channel §4 below builds on.
- The worker connects as the table owner. Migration 0003 enables (not forces) RLS with no policies
  and warns that forcing RLS would silently break the global daily ceiling's cross-user sum.

## 1. Deploy

- **Site.** `netlify sites:create --name globtrotty` and `netlify link`, from the CLI; no GitHub
  integration. Deploys are `netlify deploy --build --prod`. `netlify.toml` adds
  `[[plugins]] package = "@netlify/plugin-nextjs"`; the functions directory, bundler and the two
  schedules stay. Going live starts the sweeper (every 5 min) and the drift monitor (nightly, spends
  credit).
- **Environment.** Every key in `.env.local` is pushed with `netlify env:set`; `SITE_URL` becomes
  the site's `https://…netlify.app` URL; `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are added — the anon key is the one value that is public by
  design. `src/env.ts` gains an OPTIONAL `GOOGLE_SEARCH_API` read (`loadOptionalEnv`) so the worker
  can construct SearchApi without widening the required list the sweeper and monitor load.
- **Auth URLs.** `supabase/config.toml` `[auth]` gets `site_url` and `additional_redirect_urls` for
  the Netlify domain and `http://localhost:3000`; `supabase config push` applies them. Dashboard is
  the fallback if push refuses.
- **The production agent.** `run-turn-background.mts` builds `routeAgent` with the SDK transport
  (as `test/driver.live.test.ts` does), `KiwiSupplier`, `SearchApiHotels(GOOGLE_SEARCH_API)`, and
  `LogNotifier`. `echoAgent` stays exported for tests only.

## 2. The app

Next.js (App Router, latest stable at plan time) in the same package: `app/`, `web/` for
components and the two Supabase clients, `next.config.ts`. `pnpm build`, `pnpm dev`.

- **Sign-in.** `/login`: email field, `signInWithOtp` magic link via `@supabase/ssr`'s browser
  client; `/auth/callback` exchanges the code; a middleware refreshes the session and redirects
  anonymous requests to `/login`. One user; no sign-up UI beyond the link (Supabase creates the
  user on first link).
- **Server data reads** use the SSR server client with the user's cookie: RLS scopes every select.
  **Server writes** use the owner `DATABASE_URL` through the existing repo functions, in route
  handlers only, with `user_id` taken from the verified session and never from the body.
- **Pages.** `/` redirects to the newest conversation or shows the landing box. `/c/[id]`: the
  thread (user and agent messages, plain text, oldest first), the status line from
  `conversations.status` (`working` shows a spinner; `awaiting_user` enables the box; `failed`
  and `limit_reached` show the turn's `fail_reason` in plain words; `escalated` says a human has
  been paged), the proposal card(s) for this conversation, and the message box. Sidebar: this
  user's conversations, newest first, by `title` (falling back to the first message), with status.
- **Route handlers** (all `POST`, session required, zod-validated, `409` when a turn is in flight
  via `submitMessage`'s `busy`):
  - `POST /api/conversations/[id]/messages` `{ text }` → `submitMessage`, then `invoke(turnId)` =
    fetch to `${SITE_URL}/.netlify/functions/run-turn-background` with `x-worker-secret`. Returns
    `{ conversationId, turnId, status }`. `conversationId: null` creates a conversation.
  - `POST /api/proposals/[id]/decide` `{ decision: 'accept' | 'reject', rejectReason? }` →
    `decideProposal`, then on `accept` an **action turn** (§4) `{ action: 'hand_off', proposalId }`.
    On `reject`, an action turn `{ action: 'rejected', proposalId, reason }` so the driver can ask
    what to change.
  - `POST /api/proposals/[id]/revise` `{ slot, sourceId } | { days: -2 | 2 }` → an action turn
    `{ action: 'revise', proposalId, change }`.
- **Proposal card.** Read from `proposals` (RLS) joined to `link_clicks`: each item's slot, name,
  dates, price with its age ("found 12 min ago"), the server total, `gate_outcome` (a
  `shipped_unapproved` card shows the reviewer's issues above the buttons), `decision`. Buttons:
  Accept, Reject, per item "swap" (opens the corpus alternatives for that slot: the other
  `tool_results` rows of the same kind in this conversation, RLS-scoped, newest per id), "shift
  ±2 days". After accept, the card shows the links from `link_clicks` as the only anchors on the
  page, each with the quoted price. Decided cards lose their buttons.

## 3. Live updates

Migration 0016 adds `conversations` and `messages` to the `supabase_realtime` publication. The
browser subscribes, under RLS, to `postgres_changes` on its own rows (`filter: user_id=eq.<uid>`)
and **refetches** on any event: Realtime carries ids and statuses, never prose. Proposals and
links are refetched when the conversation status changes.

## 4. The operator channel: button actions are not text

Parent §9 maps per-component actions to `revise_component`; the cashier requires a stored
`decision`. The risk the UI adds is a *phrase* — "accept proposal X" — that a traveller, or an
injected page the model paraphrases, could type. Actions therefore never enter the transcript as
user text.

- **Storage.** `messages.role` gains `'action'` (migration 0016). An action row's `content` is JSON:
  `{ "action": "hand_off" | "revise" | "rejected", "proposalId", "change"?, "reason"? }`, validated
  by zod on write and on read. Only the three route handlers write action rows. The UI never
  renders an action row as agent text; it renders a small grey line ("You accepted the proposal").
- **Hydration.** `loop()` maps `'action'` rows to `LoopMessage { role: 'system' }` with operator
  text rendered server-side from the JSON — e.g. *"Operator: the traveller accepted proposal
  <id> using the card. Call `hand_off_to_booking` with that id now. Do not ask her to confirm."*
  The JSON is never shown to the model verbatim; ids are uuids validated by zod.
- **Request shape.** `LoopMessage.role` gains `'system'`. `withSuffix` appends the notebook to the
  **last user message** even when a `system` message follows it, so a trailing operator message
  stays last (the API forbids a user turn after a system message). `placeBreakpoints` treats a
  system block as a normal block. A request whose `messages[0]` would be a system message is
  impossible by construction: an action always follows her earlier messages.
- **Front desk.** Actions exist only after a proposal, so the conversation is at `planning`; the
  routes assert `desk = 'planning'` and `409` otherwise.
- **The forgery case.** If she types "accept proposal X" herself, it is a user message; the driver
  may call `hand_off_to_booking`, and the cashier refuses because no `decision` row exists — the
  same refusal it gives today. A test pins it.

## 5. Row security

Migration 0016, **enable-only RLS with policies** (ruling: not forced — see §8):

| table | `authenticated` grant | policy |
|---|---|---|
| `conversations`, `messages`, `turns`, `proposals`, `link_clicks`, `agent_events`, `escalations` | `select` | `user_id = auth.uid()` |
| `tool_results` | `select` | `user_id = auth.uid()` (the swap picker reads it) |
| `gate_results` | `select` | `exists (select 1 from conversations c where c.id = conversation_id and c.user_id = auth.uid())` |
| `daily_usage`, `model_calls`, `canary_runs`, `drift_alarms`, `conversions` | none | deny-all to browser roles |

No `insert`/`update`/`delete` grant to `authenticated` anywhere: every write is a route handler on
the owner connection. `anon` keeps nothing. The worker, as owner, is unaffected.

## 6. Security

- **Rendering.** Agent and user text render as plain text (`white-space: pre-wrap`), never
  markdown; URLs in prose are not linkified. The only anchors are `link_clicks.url`, with
  `rel="noopener noreferrer"` and `target="_blank"`.
- **CSP** on every route via `next.config.ts` headers: `default-src 'self'; img-src 'self' data:;
  connect-src 'self' https://<project>.supabase.co wss://<project>.supabase.co; script-src 'self'
  'nonce-…'` (or Next's strict-dynamic shape); `frame-ancestors 'none'`.
- **Outbound solicitation check.** `screenOutbound(text)` in `src/sanitize.ts`: a deterministic
  table of phrasings for card numbers, CVV, IBAN, passport or ID numbers, passwords, one-time codes,
  "send a photo of your …". `loop()` applies it to every agent message before `completeTurn`: a
  flagged message is replaced with *"I can’t continue this reply — it asked for something we
  never ask for. A person will look at this conversation."*, the original is written to
  `agent_events` (`kind: 'screened'`, migration 0016 widens the check), and `recordEscalation`
  writes a `safety` row. A persistent line under the message box: *We never ask for payment or
  passport details.*
- **Sentinel test** (new — none exists today): scans `app/`, `web/`, `next.config.ts` and
  `netlify/` for `SUPABASE_SERVICE_ROLE_KEY`, `sk-ant-`, `DATABASE_URL`, and any `NEXT_PUBLIC_`
  name other than the two Supabase public values.
- **Secrets.** `SUPABASE_SERVICE_ROLE_KEY` is not used by the app at all (reads go through RLS;
  writes through `DATABASE_URL`); it stays in env for the future retention job only.

## 7. Testing

- Route handlers, with a stubbed session: user id from the session not the body; `409` on `busy`;
  action rows written with valid JSON; `decide` writes the decision and the action row in that
  order.
- Hydration: an `action` row becomes a trailing `system` message; `withSuffix` leaves it last; a
  request built from such a transcript has no user turn after the system turn (shape test).
- Forgery: a user message "accept proposal <id>" with no decision row → the cashier refuses.
- Two-user isolation against the real Supabase project: two users created via the admin API,
  signed in with a password for the test only; user B's anon client sees none of user A's rows on
  every granted table; removing the policy predicate must fail the test. Gated on
  `LIVE_SUPABASE=1` because it needs the service role and Auth.
- `screenOutbound` table; `loop()` replaces a flagged message and writes the event and the
  escalation.
- CSP: a rendered page's headers carry `img-src 'self'`; an agent message containing
  `![](https://x/y.png)` renders as text (component test).
- Deploy smoke (the last task, run by the controller): sign in, send "a week in Portugal in
  September for two", watch `working` → `awaiting_user`, see the reply. Needs Anthropic credit.

## 8. Rulings taken here

| Ruling | Why | Cost if wrong |
|---|---|---|
| Netlify CLI deploys, no GitHub integration | no dashboard steps; the CLI is already logged in | manual deploys until an integration is added |
| RLS enabled with policies, not forced | the worker is the table owner; forcing blocks it and re-opens the `daily_usage` under-count hazard | a future non-owner writer needs policies before it can write |
| Actions travel on the system channel as JSON rows | a phrase is forgeable; a role is not | one more `messages.role` value and a hydration branch |
| `withSuffix` targets the last user message | the API forbids a user turn after a mid-conversation system message | none |
| Reads via RLS with the user's cookie; writes via the owner connection in routes | one trust boundary in the browser, one in the server | none |
| Solicitation filter is deterministic, replaces and escalates | parent §10 asks for it; a model-based check would be a new seat | false positives replace a benign reply, and page a human |
| `SITE_URL` is the Netlify URL | the functions call each other through it | one env var to change on a custom domain |
