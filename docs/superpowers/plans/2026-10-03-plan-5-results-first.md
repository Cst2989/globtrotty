# Plan 5 — Results first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first reply to a trip request is a list of real flights within ten seconds, hotels follow the chosen flight, filtering is instant, uncertainty becomes clickable options, and the window splits chat / results.

**Architecture:** A new `intake` agent (Jev decisions over code-found candidates, then a direct supplier search) answers the first message and any later message the Jev `router` classifies as a new search or a filter; the Sonnet driver handles only questions, hand-off and escalation. Two new `messages` roles, `results` and `choices`, carry ids and enums to the web layer, which renders them in a results pane beside the chat. Money, gates, the operator channel and RLS are unchanged in kind.

**Tech Stack:** TypeScript (NodeNext harness, Next 16 webpack web), postgres.js, zod, vitest, Jev REST API (`https://api.typesafe.ai/v1/systemone`, model `jev-latest`, header `Authorization: Bearer $JEV_KEY`), Kiwi flights, SearchApi hotels, Netlify.

**Spec:** `docs/superpowers/specs/2026-10-03-plan-5-results-first-design.md`

## Global Constraints

- Only `recordSpend`, `reserve`, `reconcile` move money. Jev calls are recorded as `model_calls` rows (seat `intake`, `rerank`, `router`) with `cost_micros = ceil(input_tokens * 0.042)` and debited through the existing `recordSpend` path from the worker (`costMicros` on the step), never twice.
- Trust boundary: Jev answers are option ids from lists WE wrote; nothing Jev returns is rendered as text. `results` and `choices` rows carry ids and enums only; driver-written choice labels pass `maskControlChars`. Supplier strings keep going through `maskUntrustedText` / `sanitizeSourceId`.
- `JEV_KEY` is read by `loadOptionalEnv` in the harness only; the sentinel test (`test/web-config.test.ts`) must fail if it appears under `app/` or `web/`.
- No em dashes in user-facing copy. Node 22 (`export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`). `pnpm typecheck && pnpm lint && pnpm vitest run` green before every commit; DB tests only inside `withTestDb` (rolled back). Never run `pnpm demo`. Live tests gated: `LIVE_JEV=1`, `LIVE_SUPPLIERS=1`, `LIVE_MODEL=1`.
- Speed targets (spec §6): intake ≤ 1.5 s; first results < 10 s; typed filter < 1 s with no search.
- Commit messages end with the session's attribution lines.

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/migrations/0018_plan_5_results.sql` | widen `messages.role` and `model_calls.seat` |
| `src/jev/client.ts` | thin REST client, timeout, retry, typed answers |
| `src/jev/record.ts` | `recordJevCall` into `model_calls` |
| `src/intake/places.json`, `src/intake/places.ts` | metro/airport table and fuzzy place candidates |
| `src/intake/dates.ts` | date-part resolution to ISO, nearest future |
| `src/intake/candidates.ts` | place, date-part and count candidates from text |
| `src/intake/brief.ts` | the Jev fan-out, `TripBrief`, assumptions, confidence gates |
| `src/intake/rank.ts` | Jev re-rank of supplier items |
| `src/results.ts` | `ResultsContent`, `ChoicesContent` zod + render for the transcript |
| `src/agents/intake.ts` | the intake agent: brief → search → rank → rows |
| `src/agents/router.ts` | Jev intent routing; replaces the front desk in `route.ts` |
| `src/agents/choose.ts` | `choose` action handling: proposal row, hotel search |
| `src/worker.ts` | hydrate `results` / `choices` rows; write step attachments |
| `src/actions.ts` | `choose` and `choice` arms |
| `src/tools/registry.ts`, `src/agents/driver.ts`, `src/agents/prompts/driver.md`, `src/model/seats.ts` | `offer_choices`, Sonnet seat, prompt |
| `web/chooseRoute.ts`, `app/api/conversations/[id]/choose/route.ts` | the Choose button's route |
| `web/data.ts` | `loadResults`, `loadChoices`, `loadChosen` |
| `web/components/{ResultsPane,FlightList,HotelList,FilterChips,ChoiceCard,PinnedSummary,SplitShell}.tsx` | the split UI |
| `web/components/MessageBox.tsx`, `Thread.tsx` | optimistic send |

---

### Task 1: Migration 0018 and the Jev client

**Files:**
- Create: `supabase/migrations/0018_plan_5_results.sql`, `src/jev/client.ts`, `src/jev/record.ts`
- Modify: `src/env.ts` (`loadOptionalEnv` key union), `src/model/seats.ts` (`SeatName`), `test/schema-4.test.ts` (new `test/schema-5.test.ts` instead)
- Test: `test/schema-5.test.ts`, `test/jev-client.test.ts`

**Interfaces:**
- Produces: `askJev(deps: JevDeps, req: JevRequest, signal?: AbortSignal): Promise<JevResponse>`; `type JevDeps = { apiKey: string; fetchImpl?: typeof fetch; model?: string }`; `choiceQ(instructions, criteria)`, `noulQ(instructions)`, `scoreQ(instructions, levels)` builders; `recordJevCall(sql, { conversationId, turnId, userId, seat: 'intake'|'rerank'|'router', request, response, latencyMs }): Promise<bigint>` returning `cost_micros`.

- [ ] **Step 1: Migration**

```sql
-- supabase/migrations/0018_plan_5_results.sql
-- Plan 5: two new message roles the web layer renders as cards, three Jev seats.
alter table messages drop constraint messages_role_check;
alter table messages add constraint messages_role_check
  check (role in ('user','agent','action','results','choices'));
alter table model_calls drop constraint model_calls_seat_check;
alter table model_calls add constraint model_calls_seat_check
  check (seat in ('front_desk','driver','scout','reviewer','monitor','titler','sim_user','intake','rerank','router'));
```

Check the existing constraint names first: `grep -n "seat" supabase/migrations/0001_harness.sql`; if the seat check is unnamed, drop it by the name `\d model_calls` shows against the live project (`psql "$DATABASE_URL" -c '\d model_calls'`) and write that name in the migration.

- [ ] **Step 2: Failing schema test**

```ts
// test/schema-5.test.ts
import { describe, it, expect } from 'vitest'
import { withTestDb } from './helpers/db.js'

describe('migration 0018', () => {
  it('accepts results and choices message roles and the three Jev seats', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id, status) values (gen_random_uuid(), 'active') returning id, user_id`
      for (const role of ['results', 'choices']) {
        const [m] = await sql`insert into messages (conversation_id, user_id, role, content) values (${c!.id}, ${c!.user_id}, ${role}, '{}') returning role`
        expect(m!.role).toBe(role)
      }
      const [q] = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'model_calls_seat_check'`
      expect(q!.def).toContain("'intake'")
      expect(q!.def).toContain("'rerank'")
      expect(q!.def).toContain("'router'")
    })
  })
})
```

Run: `pnpm vitest run test/schema-5.test.ts` → FAIL (constraint rejects the role). Apply the migration to the live project the way 0016/0017 were (`psql -1 -f supabase/migrations/0018_plan_5_results.sql "$DATABASE_URL"` with the URL from `.env.local`, never printed), then run again → PASS. Also append `0018` to `scripts/ci-migrate.sh`'s order if it lists files explicitly.

- [ ] **Step 3: Env and seats**

In `src/env.ts` change `key: 'GOOGLE_SEARCH_API'` to `key: 'GOOGLE_SEARCH_API' | 'JEV_KEY'`. In `src/model/seats.ts` extend `SeatName` with `| 'intake' | 'rerank' | 'router'` and add to `SEATS`:

```ts
const JEV = 'jev-latest'
  intake:     seat(JEV, null, 0, 'intake@1'),
  rerank:     seat(JEV, null, 0, 'rerank@1'),
  router:     seat(JEV, null, 0, 'router@1'),
```

(`maxTokens 0`: Jev has no output budget. The drift monitor skips seats whose model starts with `jev-`; add that one-line guard in `src/monitor/drift.ts` where seats are enumerated, with a comment.)

- [ ] **Step 4: Failing client test**

```ts
// test/jev-client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { askJev, choiceQ, noulQ, JevError } from '../src/jev/client.js'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('askJev', () => {
  it('posts state and questions with the bearer key and returns typed answers', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string)
      expect(sent.model).toBe('jev-latest')
      expect(sent.questions.party.type).toBe('choice')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
      return ok({ model: 'jev-1.13.0', answers: { party: { type: 'choice', choice: '2', confidence: 0.97, probabilities: { '1': 0.02, '2': 0.97, unstated: 0.01 } } }, usage: { input_tokens: 300, output_tokens: 20 } })
    })
    const r = await askJev({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }, {
      state: { message: 'two of us' },
      questions: { party: choiceQ('How many adults?', { '1': 'one', '2': 'two', unstated: 'not stated' }) },
    })
    expect(r.answers.party.choice).toBe('2')
    expect(r.usage.input_tokens).toBe(300)
  })

  it('retries once on 529 then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (n++ === 0 ? new Response('overloaded', { status: 529 }) : ok({ model: 'jev-1.13.0', answers: { x: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } })))
    const r = await askJev({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 }, { state: 's', questions: { x: noulQ('Is it?') } })
    expect(r.answers.x.noul).toBe(0.9)
    expect(n).toBe(2)
  })

  it('throws JevError on 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }))
    await expect(askJev({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }, { state: 's', questions: { x: noulQ('?') } })).rejects.toBeInstanceOf(JevError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 5: Client**

```ts
// src/jev/client.ts
import { z } from 'zod'

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] }

export const choiceQ = (instructions: string, criteria: Record<string, string | null>): JevQuestion => ({ type: 'choice', instructions, criteria })
export const noulQ = (instructions: string, criteria?: { true: string; false: string }): JevQuestion => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) })
export const scoreQ = (instructions: string, criteria: string[]): JevQuestion => ({ type: 'score', instructions, criteria })

export type JevRequest = { state: unknown; questions: Record<string, JevQuestion> }

const ChoiceAnswer = z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) })
const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number() })
const ScoreAnswer = z.object({ type: z.literal('score'), score: z.number(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) })
export const JevAnswer = z.discriminatedUnion('type', [ChoiceAnswer, NoulAnswer, ScoreAnswer])
export type JevAnswer = z.infer<typeof JevAnswer>
export const JevResponseSchema = z.object({ model: z.string(), answers: z.record(z.string(), JevAnswer), usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }) })
export type JevResponse = z.infer<typeof JevResponseSchema> & { latencyMs: number }

export type JevDeps = { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; retryDelayMs?: number }

export class JevError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'JevError' }
}

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** One call, one retry on 429/529, 3 s timeout. Answers are validated; an unexpected shape is a JevError(0). */
export async function askJev(deps: JevDeps, req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const body = JSON.stringify({ state: req.state, model: deps.model ?? 'jev-latest', questions: req.questions })
  const started = Date.now()
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 3000)
    signal?.addEventListener('abort', () => ctl.abort(), { once: true })
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST', body, signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.apiKey}` },
      })
      if (res.status === 429 || res.status === 529) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 300)); continue }
        throw new JevError(res.status, `jev ${res.status}`)
      }
      if (!res.ok) throw new JevError(res.status, `jev ${res.status}`)
      const parsed = JevResponseSchema.safeParse(await res.json())
      if (!parsed.success) throw new JevError(0, 'jev: unexpected response shape')
      return { ...parsed.data, latencyMs: Date.now() - started }
    } finally {
      clearTimeout(t)
    }
  }
  throw new JevError(0, 'jev: unreachable')
}

/** Jev bills input only: $0.042 per million tokens = 0.042 micro-dollars per token. */
export function jevCostMicros(inputTokens: number): bigint {
  return BigInt(Math.ceil(inputTokens * 0.042))
}
```

- [ ] **Step 6: Recorder**

```ts
// src/jev/record.ts
import type postgres from 'postgres'
import { SEATS } from '../model/seats.js'
import { jevCostMicros, type JevRequest, type JevResponse } from './client.js'

export type JevSeat = 'intake' | 'rerank' | 'router'

/** One model_calls row per Jev call; returns the cost the caller must put on its step's costMicros. */
export async function recordJevCall(sql: postgres.Sql, args: {
  conversationId: string | null; turnId: string | null; userId: string; seat: JevSeat
  request: JevRequest; response: JevResponse
}): Promise<bigint> {
  const seat = SEATS[args.seat]
  const cost = jevCostMicros(args.response.usage.input_tokens)
  await sql`
    insert into model_calls (conversation_id, turn_id, user_id, seat, prompt_version, model_config_id, effort,
      thinking_mode, max_tokens, model, request_id, system_prompt, user_prompt, response, input_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_micros, latency_ms, capture_policy)
    values (${args.conversationId}, ${args.turnId}, ${args.userId}, ${args.seat}, ${seat.promptVersion}, ${seat.modelConfigId}, null,
      null, 0, ${args.response.model}, null, ${JSON.stringify(args.request.questions)}, ${JSON.stringify(args.request.state)},
      ${sql.json(args.response.answers as never)}, ${args.response.usage.input_tokens}, 0, 0, ${args.response.usage.output_tokens},
      ${cost.toString()}, ${args.response.latencyMs}, 'full')`
  return cost
}
```

Check `model_calls` for NOT NULL columns this leaves null (`\d model_calls`); if `request_id` or `system_prompt` are NOT NULL, pass `''`. Add a `withTestDb` test in `test/jev-client.test.ts` that inserts one row for seat `intake` and reads back `cost_micros = 13` for 300 tokens.

- [ ] **Step 7: Run, commit**

`pnpm vitest run test/schema-5.test.ts test/jev-client.test.ts` → PASS. `pnpm typecheck && pnpm lint`. Commit: `feat(jev): migration 0018, REST client with retry, model_calls recorder for the three Jev seats`.

---

### Task 2: Places and candidates

**Files:**
- Create: `src/intake/places.json`, `src/intake/places.ts`, `src/intake/candidates.ts`
- Test: `test/intake-candidates.test.ts`

**Interfaces:**
- Produces: `type Place = { code: string; city: string; country: string; longHaulFrom?: string[]; aliases: string[] }`; `placeCandidates(text): PlaceCandidate[]` where `PlaceCandidate = { code: string; city: string; span: string }`; `datePartCandidates(text): DateParts` where `DateParts = { days: number[]; months: string[]; years: number[]; weekdays: string[]; relative: string[] }`; `countCandidates(text): number[]`; `isLongHaul(from: string, to: string): boolean`.

- [ ] **Step 1: The table**

`src/intake/places.json`: an array of the 300 busiest metro areas (IATA metro code where one exists, e.g. `TYO`, `LON`, `PAR`, `NYC`, `BCN`, `KIX`/`OSA` for Kyoto via Osaka) with `city`, `country`, `region` (`europe | north_america | asia | oceania | africa | south_america | middle_east`) and `aliases` (local names and common misspellings: `tokio`, `kioto`, `barcelone`, `lisboa`, `münchen`, `munich`, `roma`). Build it with a short script from an open dataset (OurAirports `airports.csv` + a hand-written alias list; keep the script in `scripts/build-places.mjs`, commit the JSON). Long haul is derived: different `region` ⇒ long haul.

- [ ] **Step 2: Failing tests**

```ts
// test/intake-candidates.test.ts
import { describe, it, expect } from 'vitest'
import { placeCandidates, datePartCandidates, countCandidates } from '../src/intake/candidates.js'
import { isLongHaul } from '../src/intake/places.js'

const MSG = 'i need to be in tokio with my wife on 20th of nov, from barcelona, and back in barcelona sunday 6th of december. i will also travel in kioto, nintendo museum on the 3rd'

describe('candidates', () => {
  it('finds misspelled and local place names with their spans', () => {
    const p = placeCandidates(MSG)
    expect(p.map((x) => x.code)).toEqual(expect.arrayContaining(['TYO', 'BCN', 'OSA']))
    expect(p.find((x) => x.code === 'TYO')!.span).toBe('tokio')
  })
  it('finds date parts without doing calendar math', () => {
    const d = datePartCandidates(MSG)
    expect(d.days).toEqual(expect.arrayContaining([20, 6, 3]))
    expect(d.months).toEqual(expect.arrayContaining(['november', 'december']))
    expect(d.weekdays).toEqual(['sunday'])
    expect(d.years).toEqual([])
  })
  it('reads party hints', () => {
    expect(countCandidates('two of us')).toContain(2)
    expect(countCandidates(MSG)).toContain(2) // "my wife" implies 2
  })
  it('knows Barcelona to Tokyo is long haul and Tokyo to Osaka is not', () => {
    expect(isLongHaul('BCN', 'TYO')).toBe(true)
    expect(isLongHaul('TYO', 'OSA')).toBe(false)
  })
})
```

- [ ] **Step 3: Implementation**

`places.ts`: load the JSON once; `normalise(s)` lowercases, strips accents (`normalize('NFD')` + remove combining marks) and punctuation; build a `Map<alias, Place>` over `city`, `code` and `aliases`; `placeCandidates` scans the message's 1- to 3-word windows against the map and also accepts a Damerau-Levenshtein distance ≤ 1 for words of 5+ letters (so `tokio` → `tokyo` even without the alias). Return unique codes in order of appearance with the matched span. `datePartCandidates`: regexes for `\b(\d{1,2})(st|nd|rd|th)?\b` limited to 1..31, month names and 3-letter abbreviations (`nov` → `november`), 4-digit years 2024..2032, weekday names, and relative words (`today`, `tomorrow`, `next`, `this`). `countCandidates`: digits 1..9, number words one..nine, and the phrases `my wife|my husband|my partner|the two of us|couple` → 2, `family` → 4 only as a hint flagged by the caller (return `[2]` for partner phrases, nothing for family; the brief handles family via Jev).

- [ ] **Step 4: Run, commit**

PASS. Commit: `feat(intake): place table with aliases, place/date/count candidates`.

---

### Task 3: Date resolution and the brief

**Files:**
- Create: `src/intake/dates.ts`, `src/intake/brief.ts`
- Test: `test/intake-dates.test.ts`, `test/intake-brief.test.ts`, fixtures under `test/fixtures/jev/`

**Interfaces:**
- Produces: `resolveDate(parts: { month: string | null; day: number | null; year: number | null; relative?: string | null; weekday?: string | null }, today: Date): { iso: string; assumed: 'year' | 'none' } | null`; `type TripBrief = { origin: string; destination: string; sideTrip: string | null; outbound: string; inbound: string | null; adults: number; cabinLong: Cabin; cabinShort: Cabin; maxStops: number | null; hotels: boolean; arriveBy: boolean; assumptions: Assumption[] }`; `type Cabin = 'economy' | 'premium_economy' | 'business' | 'first'`; `type Assumption = { field: string; value: string; reason: 'unstated' | 'defaulted' | 'year' }`; `type IntakeOutcome = { kind: 'brief'; brief: TripBrief } | { kind: 'choices'; question: string; options: { id: string; label: string }[] }`; `buildIntakeQuestions(text, candidates)`; `assembleBrief(answers, candidates, today, lastOrigin: string | null): IntakeOutcome`; `runIntake(deps: { jev: JevDeps }, text, today, lastOrigin): Promise<{ outcome: IntakeOutcome; request: JevRequest; response: JevResponse }>`.

- [ ] **Step 1: Date tests**

```ts
// test/intake-dates.test.ts
import { describe, it, expect } from 'vitest'
import { resolveDate } from '../src/intake/dates.js'

const today = new Date('2026-10-03T12:00:00Z')
describe('resolveDate', () => {
  it('assumes the nearest future year when none is stated', () => {
    expect(resolveDate({ month: 'november', day: 20, year: null }, today)).toEqual({ iso: '2026-11-20', assumed: 'year' })
    expect(resolveDate({ month: 'march', day: 5, year: null }, today)).toEqual({ iso: '2027-03-05', assumed: 'year' })
  })
  it('keeps a date up to 30 days in the past in the current year (she may be mid-trip)', () => {
    expect(resolveDate({ month: 'september', day: 20, year: null }, today)!.iso).toBe('2026-09-20')
  })
  it('honours a stated year and rejects impossible dates', () => {
    expect(resolveDate({ month: 'february', day: 30, year: 2027 }, today)).toBeNull()
    expect(resolveDate({ month: 'december', day: 6, year: 2026 }, today)).toEqual({ iso: '2026-12-06', assumed: 'none' })
  })
  it('resolves a bare weekday to the next occurrence and "next" to the following week', () => {
    expect(resolveDate({ month: null, day: null, year: null, weekday: 'friday' }, today)!.iso).toBe('2026-10-09')
    expect(resolveDate({ month: null, day: null, year: null, weekday: 'friday', relative: 'next' }, today)!.iso).toBe('2026-10-16')
  })
})
```

Implement `dates.ts` in UTC with `Date.UTC`; the 30-day grace rule and the weekday rules exactly as the tests say.

- [ ] **Step 2: The question set**

`buildIntakeQuestions(text, c)` returns `Record<string, JevQuestion>`:

```ts
const placeCriteria = Object.fromEntries([...c.places.map((p) => [p.code, `${p.city} (she wrote "${p.span}")`]), ['none', 'No place in the list is this']])
const months = Object.fromEntries([...MONTHS.map((m) => [m, null]), ['unstated', 'No month is stated for this date']])
const days = Object.fromEntries([...Array.from({ length: 31 }, (_, i) => [String(i + 1), null]), ['unstated', 'No day is stated']])
return {
  origin: choiceQ('Which place is she travelling FROM (her home or departure city)?', placeCriteria),
  destination: choiceQ('Which place is the MAIN destination of the trip?', placeCriteria),
  side_trip: choiceQ('Which place, if any, is a SIDE TRIP from the main destination?', placeCriteria),
  outbound_month: choiceQ('The month of the OUTBOUND date (arrival or departure)', months),
  outbound_day: choiceQ('The day of the month of the OUTBOUND date', days),
  return_month: choiceQ('The month of the RETURN date', months),
  return_day: choiceQ('The day of the month of the RETURN date', days),
  outbound_year: choiceQ('The year of the outbound date', { [String(year)]: null, [String(year + 1)]: null, unstated: 'No year is stated' }),
  outbound_weekday: choiceQ('A weekday named for the outbound date', { ...WEEKDAYS, none: 'No weekday for the outbound' }),
  outbound_relative: choiceQ('How the outbound date is phrased', { absolute: 'A calendar date is named', relative: 'Relative to today, e.g. tomorrow, next Friday', none: 'No outbound date at all' }),
  party_adults: choiceQ('How many adults travel?', { '1': null, '2': 'Two, including phrases like "my wife", "the two of us"', '3': null, '4': null, '5': null, '6': null, unstated: 'Not stated' }),
  trip_type: choiceQ('Is this a return trip or one way?', { return: 'She comes back (a return date or "back" is mentioned)', one_way: 'Only an outward journey', unstated: 'Cannot tell' }),
  cabin_long: choiceQ('Cabin for the LONG flights', { economy: null, premium_economy: null, business: null, first: null, unstated: 'Not stated' }),
  cabin_short: choiceQ('Cabin for the SHORT flights', { economy: null, premium_economy: null, business: null, first: null, unstated: 'Not stated' }),
  max_stops: choiceQ('Stops she will accept', { nonstop_only: 'Direct only', one_stop_ok: 'A connection is fine or not mentioned as a problem', unstated: 'Not stated' }),
  hotels_wanted: noulQ('Does she want accommodation arranged too?'),
  arrive_by: noulQ('Is the outbound date the day she must BE THERE (an arrival deadline) rather than the day she leaves?'),
  fixed_commitment: noulQ('Does she name a dated event she must attend during the trip?'),
}
```

`state` is `{ message: text, today: today.toISOString().slice(0, 10), candidates: { places: c.places, dates: c.dates, counts: c.counts } }`.

- [ ] **Step 3: Brief tests with a recorded fixture**

Record one real Jev response for the Tokyo message (`LIVE_JEV=1 node scripts/record-jev.mjs "<message>" > test/fixtures/jev/tokyo.json`; write that 20-line script: it calls `askJev` with `JEV_KEY` from `.env.local` and prints the JSON). Then:

```ts
// test/intake-brief.test.ts
import { describe, it, expect } from 'vitest'
import tokyo from './fixtures/jev/tokyo.json'
import { assembleBrief } from '../src/intake/brief.js'
import { placeCandidates, datePartCandidates, countCandidates } from '../src/intake/candidates.js'

const MSG = '...the Tokyo message...'
const today = new Date('2026-10-03T12:00:00Z')
const cands = { places: placeCandidates(MSG), dates: datePartCandidates(MSG), counts: countCandidates(MSG) }

describe('assembleBrief', () => {
  it('builds a complete brief from the Tokyo message with the year assumed and arrival moved a day earlier', () => {
    const out = assembleBrief(tokyo.answers, cands, today, null)
    expect(out.kind).toBe('brief')
    if (out.kind !== 'brief') return
    expect(out.brief).toMatchObject({ origin: 'BCN', destination: 'TYO', sideTrip: 'OSA', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2, cabinLong: 'premium_economy', cabinShort: 'economy', hotels: true, arriveBy: true })
    expect(out.brief.assumptions.map((a) => a.field)).toEqual(expect.arrayContaining(['year', 'outbound']))
  })
  it('returns a choice card when the destination is below 0.6 confidence', () => {
    const low = structuredClone(tokyo.answers)
    low.destination = { type: 'choice', choice: 'TYO', confidence: 0.4, probabilities: { TYO: 0.4, OSA: 0.35, BCN: 0.15, none: 0.1 } }
    const out = assembleBrief(low, cands, today, null)
    expect(out.kind).toBe('choices')
    if (out.kind !== 'choices') return
    expect(out.options.map((o) => o.id)).toEqual(['TYO', 'OSA', 'BCN'])
    expect(out.options[0]!.label).toBe('Tokyo')
  })
  it('falls back to the last used origin, then to a choice card', () => {
    const noOrigin = structuredClone(tokyo.answers)
    noOrigin.origin = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9, TYO: 0.1 } }
    expect(assembleBrief(noOrigin, cands, today, 'MAD').kind).toBe('brief')
    expect(assembleBrief(noOrigin, cands, today, null).kind).toBe('choices')
  })
})
```

- [ ] **Step 4: assembleBrief rules**

Confidence threshold `0.6` for `origin`, `destination`, `outbound_*`; `return_*` below 0.6 or `unstated` ⇒ `inbound = outbound + 7 nights` with assumption `defaulted`. `party_adults` unstated ⇒ `1` (`unstated`). Cabins unstated ⇒ `economy` (`unstated`). `max_stops`: `nonstop_only` ⇒ `0`, else `null`. `arrive_by` noul > 0.6 and `isLongHaul(origin, destination)` ⇒ outbound minus one day, assumption `{ field: 'outbound', value: iso, reason: 'defaulted' }` with the explanation text built by the caller. `side_trip` is `null` when `none` or equal to destination. A choice card's options are the top three non-`none` probabilities, labels from the place table (never the span she typed, never the model). Question text per field is a fixed sentence: `Which city are you flying from?`, `Where is the trip to?`, `Which date do you leave?` (the date card offers the three candidate day/month combinations as ISO labels).

- [ ] **Step 5: runIntake and the live test**

`runIntake` = candidates → questions → `askJev` → `assembleBrief`; returns the request and response too so the agent can record the call. Live test `test/intake.live.test.ts` gated on `process.env.LIVE_JEV === '1'`: the Tokyo message yields `destination TYO`, `origin BCN`, `adults 2`, `outbound 2026-11-19` for `today = 2026-10-03`.

- [ ] **Step 6: Run, commit**

PASS. Commit: `feat(intake): date resolution, the Jev fan-out and brief assembly with confidence gates`.

---

### Task 4: Results and choices rows, worker hydration, step attachments

**Files:**
- Create: `src/results.ts`
- Modify: `src/worker.ts` (hydration at the `role === 'action'` branch; `AgentStep` gains `attachments?`), `src/actions.ts`
- Test: `test/results.test.ts`, `test/worker-attachments.test.ts`, extend `test/actions.test.ts`

**Interfaces:**
- Produces: `ResultsContent = { kind: 'flights' | 'hotels'; query: { from?: string; to?: string; place?: string; outbound: string; inbound: string | null; adults: number; cabin?: Cabin }; sourceIds: string[]; assumptions: Assumption[]; filter?: Filter }`; `Filter = { nonstop?: boolean; maxStops?: number; departure?: 'morning' | 'afternoon' | 'evening'; maxPriceMinor?: string; airlines?: string[] }`; `ChoicesContent = { questionId: string; question: string; options: { id: string; label: string }[] }`; `parseResults`, `parseChoices`, `renderResultsNote(r): string`, `renderChoicesNote(c): string`; `AgentStep` message/park arms gain `attachments?: { role: 'results' | 'choices'; content: ResultsContent | ChoicesContent }[]`; `ActionPayload` gains `{ action: 'choose', kind: 'flight' | 'hotel', sourceId }` and `{ action: 'choice', questionId, optionId }`.

- [ ] **Step 1: Tests**

```ts
// test/results.test.ts
import { describe, it, expect } from 'vitest'
import { parseResults, renderResultsNote, parseChoices, renderChoicesNote } from '../src/results.js'

describe('results rows', () => {
  it('round-trips and renders ids only', () => {
    const r = parseResults(JSON.stringify({ kind: 'flights', query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2, cabin: 'premium_economy' }, sourceIds: ['kiwi:a"b', 'kiwi:c'], assumptions: [] }))
    expect(r).not.toBeNull()
    const note = renderResultsNote(r!)
    expect(note).toContain('10 flights'.replace('10', '2'))
    expect(note).not.toContain('"')
    expect(note).not.toContain('\n')
  })
  it('rejects extra fields and user text in a choices row', () => {
    expect(parseChoices(JSON.stringify({ questionId: 'origin', question: 'x', options: [{ id: 'BCN', label: 'Barcelona' }], extra: 1 }))).toBeNull()
  })
  it('renders a choices note with ids and labels masked', () => {
    const c = parseChoices(JSON.stringify({ questionId: 'origin', question: 'Which city are you flying from?', options: [{ id: 'BCN', label: 'Barce\nlona' }] }))!
    expect(renderChoicesNote(c)).not.toContain('\n')
  })
})
```

`renderResultsNote`: `Operator: the office showed her ${n} ${kind} for ${from ?? place} to ${to ?? ''} on ${outbound}${inbound ? ' returning ' + inbound : ''}; ids ${ids.map(maskIdChars).join(', ')}. Discuss them; do not search again unless she changes the trip.` `renderChoicesNote`: `Operator: the office asked her "${maskControlChars(question)}" with options ${options.map(o => o.id).join(', ')}. Wait for her click.`

- [ ] **Step 2: Worker**

In `src/worker.ts` where `r.role === 'action'` is hydrated, add `results` and `choices` branches producing `role: 'system'` messages via the two renderers (unreadable ⇒ the existing `UNREADABLE_ACTION_TEXT`). After `loop()` writes the agent `message` row (find the `insert into messages` for `role 'agent'`), write each attachment as its own row with `created_at = clock_timestamp()` so it sorts after the text. Test in `test/worker-attachments.test.ts` with `withTestDb` and a stub agent returning one `message` step with one `results` attachment: two rows, roles `['agent', 'results']` in `created_at` order, and the next turn's hydrated transcript contains a system message with the ids.

- [ ] **Step 3: Actions**

Add to `ActionPayload`: `z.strictObject({ action: z.literal('choose'), kind: z.enum(['flight', 'hotel']), sourceId: z.string().min(1).max(512) })` and `z.strictObject({ action: z.literal('choice'), questionId: z.string().regex(/^[a-z_]{1,32}$/), optionId: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/) })`. `renderActionMessage`: `choose` ⇒ `Operator: the traveller chose ${kind} ${maskIdChars(sourceId)} from the list. The office has recorded it and is searching the next step; do not ask her to confirm.`; `choice` ⇒ `Operator: to the question ${questionId} she chose ${optionId}.` `describeActionForUi`: `You chose a flight` / `You chose a hotel` / `You answered a question`. Tests: parse, render contains no `"`, user text in `optionId` (`"Tokyo please"`) is rejected.

- [ ] **Step 4: Run, commit**

PASS. Commit: `feat(results): results and choices rows, worker hydration and attachments, choose and choice actions`.

---

### Task 5: The intake agent and re-rank

**Files:**
- Create: `src/intake/rank.ts`, `src/agents/intake.ts`
- Modify: `src/agents/route.ts` (intake replaces the front desk for `desk = 'front'`), `netlify/functions/run-turn-background.mts` (pass `jev`)
- Test: `test/intake-rank.test.ts`, `test/agent-intake.test.ts`

**Interfaces:**
- Consumes: `runIntake`, `recordJevCall`, `recordResults`, `Supplier.search`, `readDesk`/`setDesk` from `src/repo/conversations.ts`.
- Produces: `rankItems(deps: { jev: JevDeps }, brief: TripBrief, items: SupplierItem[]): Promise<{ ordered: SupplierItem[]; request; response }>`; `makeIntake(deps: DriverDeps & { jev: JevDeps }): Agent`; `type IntakeDeps = DriverDeps & { jev: JevDeps }`.

- [ ] **Step 1: Re-rank**

One Jev call with `state = { preferences: { cabinLong, cabinShort, maxStops, arriveBy, outbound, inbound }, options: items.slice(0, 20).map(summary) }` where `summary(item)` is `{ id: index, price, airlines, stops, departLocal, arriveLocal, durationHours, cabin, selfTransfer, bags }` (numbers and enum-like strings only; airline names through `maskUntrustedText`), and one `scoreQ` per option keyed `o0..o19`: `'How well does option oN match her preferences?'` with levels `['Violates a stated preference', 'Acceptable', 'Good fit', 'Best possible fit']`. Order by score desc, then price asc. Test with a fixture of three scores.

- [ ] **Step 2: The agent**

```ts
// src/agents/intake.ts (shape)
export function makeIntake(deps: IntakeDeps): Agent {
  return async (ctx) => {
    const text = lastUserText(ctx.state)                       // the newest user message's text
    const today = new Date(deps.now())
    const lastOrigin = await readLastOrigin(deps.sql, ctx.userId)   // most recent flights results row's query.from, or null
    const { outcome, request, response } = await runIntake({ jev: deps.jev }, text, today, lastOrigin)
    let cost = await recordJevCall(deps.sql, { conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId, seat: 'intake', request, response })
    if (outcome.kind === 'choices') {
      return { kind: 'park', text: outcome.question, costMicros: cost, attachments: [{ role: 'choices', content: { questionId: outcome.questionId, question: outcome.question, options: outcome.options } }] }
    }
    const b = outcome.brief
    const params: FlightSearch = { kind: 'flight', from: b.origin, to: b.destination, departureDate: b.outbound, returnDate: b.inbound, flexDays: 0, adults: b.adults, children: 0, infants: 0, cabinClass: kiwiCabin(b.cabinLong), currency: 'EUR', maxStops: b.maxStops, allowSelfTransfer: false }
    const items = await deps.flights.search(params)
    await recordResults(deps.sql, { conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items })
    const ranked = items.length > 1 ? await rankItems({ jev: deps.jev }, b, items) : { ordered: items, request: null, response: null }
    if (ranked.response) cost += await recordJevCall(deps.sql, { ...ids, seat: 'rerank', request: ranked.request!, response: ranked.response })
    await setDesk(deps.sql, ctx.conversationId, ctx.userId, 'planning')
    await writeBrief(deps.sql, ctx, b)                          // notebook patch through the existing notebook repo: party, dates, origin, destination, cabin
    const text = replyText(b, ranked.ordered.length)
    return { kind: 'park', text, costMicros: cost, attachments: [{ role: 'results', content: { kind: 'flights', query: {...}, sourceIds: ranked.ordered.slice(0, 10).map((i) => i.sourceId), assumptions: b.assumptions } }] }
  }
}
```

`replyText` is fixed English built only from the brief's enum/ISO values and place-table names: `Here are flights for 2 adults, Barcelona to Tokyo, 19 Nov to 6 Dec, premium economy. I assumed: the year 2026; leaving a day early so you arrive on the 20th. Change anything with the chips above the list or just tell me.` A supplier error ⇒ `{ kind: 'fail', reason: 'provider_down', ... }` per the existing shape. `kiwiCabin` maps the enum to Kiwi's `Economy | PremiumEconomy | Business | First`. `park` is the step kind that ends the turn awaiting her (check `AgentStep`'s union in `src/worker.ts` and use the arm the driver's `ask_user` uses).

- [ ] **Step 3: Route and function**

`route.ts`: `desk === 'front' ? intake(ctx) : router(ctx)` (router arrives in Task 6; until then `driver(ctx)`). `run-turn-background.mts`: `jev: { apiKey: loadOptionalEnv(process.env, 'JEV_KEY') ?? throwMissing('JEV_KEY') }`; a missing key fails the function loudly at construction like a missing `DATABASE_URL`.

- [ ] **Step 4: Agent test**

`test/agent-intake.test.ts` with `withTestDb`, `MockSupplier` for flights, a stubbed `fetchImpl` for Jev returning the Tokyo fixture then a rank fixture: the step is `park` with one `results` attachment of ≤ 10 ids that all exist in `tool_results` for that conversation, `conversations.desk` is `planning`, two `model_calls` rows (`intake`, `rerank`), and `costMicros` equals their `cost_micros` sum.

- [ ] **Step 5: Run, commit**

PASS. Commit: `feat(agents): the intake agent: brief, direct flight search, Jev re-rank, results row`.

---

### Task 6: The router and filters

**Files:**
- Create: `src/agents/router.ts`, `src/intake/filter.ts`
- Modify: `src/agents/route.ts`, `src/agents/frontDesk.ts` (keep the FAQ answers table; delete the Haiku call), `src/model/seats.ts` (`front_desk` stays declared)
- Test: `test/agent-router.test.ts`, `test/intake-filter.test.ts`

**Interfaces:**
- Produces: `applyFilter(items: StoredItem[], f: Filter): StoredItem[]` (pure); `routeMessage(deps, text, hasResults): Promise<{ intent: 'filter' | 'new_search' | 'question' | 'chat' | 'faq'; filter?: Filter; request; response }>`; `makeRouter(deps: IntakeDeps): Agent`.

- [ ] **Step 1: Filter tests and implementation**

`applyFilter`: `nonstop` ⇒ both legs `stops === 0`; `maxStops`; `departure` windows (morning < 12:00 local, afternoon 12:00–17:59, evening ≥ 18:00) on the outbound leg; `maxPriceMinor`; `airlines` (any leg's carrier in the list). Three tests on hand-built `StoredItem`s.

- [ ] **Step 2: Routing questions**

One Jev call, `state = { message, hasResults, lastQuery }`:

```ts
intent: choiceQ('What does this message do?', {
  filter: 'Narrows or re-sorts the flights or hotels already shown (direct only, cheaper, morning, a specific airline)',
  new_search: 'Changes the trip itself: other dates, another city, more people, a different cabin, or asks to search again',
  question: 'Asks for advice or information that needs a written answer',
  chat: 'Small talk, thanks, or a reply to a question the desk asked',
  faq: 'A question about the agency itself: payment, cancellations, visas, how prices are checked',
}),
nonstop: noulQ('She wants direct flights only'),
departure: choiceQ('A departure time of day she asks for', { morning: null, afternoon: null, evening: null, none: 'None' }),
cheaper: noulQ('She asks for cheaper options or a price cap'),
```

Airline names: match the message against the carriers present in the latest results row (code-side, no Jev). `filter` ⇒ `Filter` built from the answers; `new_search` ⇒ the intake agent runs on this message (the brief merges with the notebook: a field Jev marks `unstated` keeps the notebook value); `question`/`chat` ⇒ the driver; `faq` ⇒ the fixed answer from `frontDesk.ts`'s table, no model.

- [ ] **Step 3: The router agent**

`makeRouter(deps)`: on a step whose newest transcript row is an `action` (`choose`/`choice`/`hand_off`/...) hand straight to `choose` handling (Task 7) or the driver; otherwise `routeMessage`. For `filter`: load the latest `results` row, `rehydrate` its ids, `applyFilter`, and return `park` with text `Showing ${n} of ${total}: ${describeFilter(f)}.` plus a `results` attachment with the same `kind`/`query`, the filtered ids and `filter: f`. Record the router call as seat `router`.

- [ ] **Step 4: Tests**

Fixtures for `intent` answers; `withTestDb` test: a conversation with a results row and three stored flights; the message `only direct flights` yields a `park` step with a results attachment containing only the nonstop ids and `filter.nonstop === true`, and no supplier call (spy on `flights.search`).

- [ ] **Step 5: Run, commit**

PASS. Commit: `feat(agents): Jev intent router replaces the front desk; instant filters over stored results`.

---

### Task 7: Choose: proposals, hotels, the pinned summary

**Files:**
- Create: `src/agents/choose.ts`, `web/chooseRoute.ts`, `app/api/conversations/[id]/choose/route.ts`
- Modify: `src/agents/router.ts`, `src/repo/proposals.ts` (`insertChosen`), `web/data.ts`
- Test: `test/agent-choose.test.ts`, `test/web-api-choose.test.ts`

**Interfaces:**
- Consumes: `runProposalPath`, `recordResults`, `submitAction` (`onFreshTurn`), `loadProposalForUser` patterns from `web/decideRoute.ts`.
- Produces: `handleChoose(deps: IntakeDeps, ctx, action: { kind: 'flight' | 'hotel'; sourceId }): Promise<AgentStep>`; route `POST /api/conversations/[id]/choose` body `{ kind, sourceId }` ⇒ 200 `{ ok: true }`, 404 unknown or not hers or id not in this conversation's corpus of that kind, 409 busy / not planning, 429 limit; `loadChosen(sb, conversationId): Promise<{ flight: ProposalItemLite | null; hotel: ProposalItemLite | null; proposalId: string | null }>`.

- [ ] **Step 1: Route**

`web/chooseRoute.ts` mirrors `web/reviseRoute.ts`: `withUser`, uuid check, ownership select on the owner connection, corpus pre-check (`select 1 from tool_results where conversation_id = … and source_id = … and kind = …`), then `submitAction(deps, { userId, conversationId, action: { action: 'choose', kind, sourceId }, idempotencyKey })`. Tests as in `test/web-api-proposals.test.ts`: another user's conversation ⇒ 404 and no rows; unknown sourceId ⇒ 404; busy ⇒ 409.

- [ ] **Step 2: handleChoose**

Flight: `runProposalPath(deps, ctx, spent, { refs: [{ sourceId, quantity: 1, slot: 'flight' }], notebook, round, parentProposalId: null })`; on success find the new proposal row and set `decision = 'accept'` (through `decideProposal` with `deps.sql`, same function the card uses). Then the hotel search: `query = placeName(destination)`, `checkIn = outbound arrival date`, `checkOut = inbound date` (or `+7` nights when one way), `adults` from the brief/notebook; `recordResults`; `park` with text `Flight noted. Here are hotels in Tokyo for 20 Nov to 6 Dec.` and a `results` attachment `kind: 'hotels'`. A side trip with a `fixed_commitment` gets a second hotel search for the commitment date ± 1 night, appended as a second attachment. Hotel: proposal with refs `[flight, stay]` through `runProposalPath` (gates + reviewer), `decision = 'accept'`, `park` with text `Trip summary ready. Use "Get booking links" when you want the links.` and no attachment; the web pinned summary offers the existing `hand_off` action.

- [ ] **Step 3: Tests**

`withTestDb` + `MockSupplier`: choose a stored flight ⇒ one accepted proposal with one `flight` item, hotels searched (spy), a hotels results attachment; choose a stored hotel afterwards ⇒ a second proposal with two items and `gate_results` rows for the round.

- [ ] **Step 4: Run, commit**

PASS. Commit: `feat(choose): flight choice records a proposal and searches hotels; hotel choice runs gates and the reviewer`.

---

### Task 8: The driver steps back

**Files:**
- Modify: `src/model/seats.ts`, `src/agents/prompts/driver.md`, `src/tools/registry.ts`, `src/agents/driver.ts`, `src/notebook.ts` (export the key list), `src/model/client.ts` (date line in `withSuffix`)
- Test: `test/driver.test.ts` (existing cases), `test/prompts.test.ts`, `test/model-client.test.ts`

- [ ] **Step 1: Seat**

`driver: seat('claude-sonnet-5', 'medium', 4_000, 'driver@4')`; keep `reviewer` on Opus.

- [ ] **Step 2: Prompt**

In `driver.md`: replace "## When to ask" with:

```
## Never ask in free text

The office searches first and shows her lists; you join after. If you truly cannot continue
without her, call `offer_choices` with one question and 2 to 4 options, and stop. Never ask
for a budget: price is a filter she applies to results. Never ask which year: the office
tells you today's date at the end of every message, and a date without a year is the next
one in the future.
```

Add a "## Notebook keys" section listing the allowed keys from `src/notebook.ts`, generated at prompt load (`loadPrompt('driver')` + a `{{NOTEBOOK_KEYS}}` placeholder replaced in code; `test/prompts.test.ts` pins that the rendered prompt contains every key). Bump the version comment. In `withSuffix`, prepend `Today is YYYY-MM-DD.` to the notebook suffix text (the suffix is already outside the cached prefix; pin it in `test/model-client.test.ts`).

- [ ] **Step 3: Tool**

`registry.ts`: remove `ask_user`; add `offer_choices: { schema: z.strictObject({ question: z.string().min(1).max(200), options: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]{1,24}$/), label: z.string().min(1).max(60) })).min(2).max(4) }), door: 'code', description: 'Ask ONE question with 2 to 4 clickable options and stop. Only when you cannot continue.' }`. `driver.ts`: the `ask_user` case becomes `offer_choices`: labels and question through `maskControlChars`, returns `park` with a `choices` attachment (`questionId: 'driver'`). Update `test/driver.test.ts`'s ask case accordingly; `update_requirements`'s description lists the keys.

- [ ] **Step 4: Run, commit**

PASS (`pnpm vitest run test/driver.test.ts test/prompts.test.ts test/model-client.test.ts test/tools*.test.ts`). Commit: `feat(driver): Sonnet medium, no free-text questions, offer_choices, today's date and notebook keys in the prompt`.

---

### Task 9: Web data and the results components

**Files:**
- Create: `web/components/FlightList.tsx`, `HotelList.tsx`, `FilterChips.tsx`, `ChoiceCard.tsx`, `PinnedSummary.tsx`, `ResultsPane.tsx`, `web/filters.ts`
- Modify: `web/data.ts`, `web/components/MessageBubble.tsx` (renders `results` rows as a one-line marker "10 flights shown" and `choices` rows through `ChoiceCard`), `app/globals.css`
- Test: `test/web-results-render.test.ts`, `test/web-filters.test.ts`

**Interfaces:**
- Produces: `loadResults(sb, conversationId): Promise<ResultsView[]>` where `ResultsView = { messageId: string; kind; query; assumptions; filter; items: ResultItemLite[] }` and `ResultItemLite = { sourceId; name; priceMinor; currency; fetchedAt; ttlSeconds; flight?: { outbound: LegLite; inbound: LegLite | null; stops: number; durationMinutes: number; airlines: string[]; bags: { cabin: number; checked: number }; selfTransfer: boolean }; hotel?: { rating: number | null; nights: number; checkIn; checkOut } }`; `applyFilterLite(items, filter)` in `web/filters.ts` (same semantics as `src/intake/filter.ts`, over the lite shape); `loadChoices(sb, conversationId): Promise<ChoicesContent & { messageId } | null>` (the newest unanswered choices row: none of the later rows is a `choice` action for its `questionId`).

- [ ] **Step 1: Data**

`loadResults` reads `messages` rows with `role = 'results'` through RLS, parses with `parseResults` (import from `src/results.ts`), and rehydrates ids from `tool_results` (the newest row per `source_id`, as `loadAlternatives` does), mapping payloads to `ResultItemLite` with every string through the existing masks. Render tests pin that a supplier name containing `<script>` is escaped and that expired ids are dropped.

- [ ] **Step 2: Components**

`FlightList`: a list of rows, each: airline(s) and times for outbound and inbound (`07:05 BCN → 10:20+1 HND`), stops as words (`Nonstop`, `1 stop, DOH`), duration, bags icons (Phosphor `Suitcase`, `Backpack`), price right-aligned, fetched age, a `Choose` button (`btn btn-primary btn-sm`) calling `onChoose(sourceId)`; a chosen item (prop `chosenSourceId`) renders pinned with a `Chosen` state and no button. `HotelList`: name, rating as stars text, nights and dates, price, `Choose`. `FilterChips`: toggle chips for nonstop / up to 1 stop / morning / afternoon / evening, a price cap `<select>` (five steps from the min to the max price in the list), airline chips from the list; state lifted to `ResultsPane` (client) and applied with `applyFilterLite`. `ChoiceCard`: the question and 2 to 4 `btn btn-ghost` buttons; `onPick(optionId, label)`. `PinnedSummary`: chosen flight and hotel with total and the existing hand-off (`Get booking links`) button wired to `/api/proposals/[id]/decide` with `{ decision: 'accept' }` only when `proposal.decision` is null, else the links list. `ResultsPane` composes them: assumptions chips (`Assumed: 2026`, `Leaving 19 Nov to arrive by the 20th`) at the top, then the pinned summary when anything is chosen, then the newest hotels list (if any), then the newest flights list. Every component is pure (callbacks as props) so `renderToStaticMarkup` tests can pin: no `<a>` except in `PinnedSummary`'s links, `Choose` absent once chosen, filter chips reduce the rendered rows.

- [ ] **Step 3: ChoiceCard click**

`ChoiceCardLive`: `POST /api/conversations/[id]/messages` with `{ text: label, idempotencyKey, choice: { questionId, optionId } }`; `web/messagesRoute.ts` accepts the optional `choice` (zod strict) and, when present, calls `submitAction` with the `choice` action **and** `userNote: label` on the same fresh turn (reuse `onFreshTurn` ordering: note row then action row). Test in `test/web-api-messages.test.ts`: both rows written, the action row parses to `choice`.

- [ ] **Step 4: Run, commit**

PASS. Commit: `feat(web): results data, flight and hotel lists, filter chips, choice card, pinned summary`.

---

### Task 10: The split shell, mobile tabs, optimistic send

**Files:**
- Create: `web/components/SplitShell.tsx`
- Modify: `web/components/AppShell.tsx`, `Sidebar.tsx` (collapsed variant), `Thread.tsx`, `MessageBox.tsx`, `app/c/[id]/page.tsx`, `app/globals.css`
- Test: `test/web-render.test.ts` (new cases), `test/web-middleware.test.ts` unchanged

- [ ] **Step 1: Shell**

`AppShell` gains `rail: ReactNode`, `collapsed: boolean` (default from a prop the page computes: `hasResults`), a `data-rail-collapsed` attribute, and an expand/collapse button in the rail top. CSS: collapsed rail is `56px` with the wordmark mark, New trip and the expand control; hovering or clicking expands it as an overlay (same drawer mechanics as mobile). `SplitShell` lays out `chat` (25%, `min-width: 320px`, the `Thread` with its composer) and `results` (`ResultsPane`) side by side above 1024px, and a two-tab layout (`Chat` | `Results`, badge when a newer results row arrives than the one last seen, stored in `sessionStorage` under try/catch) below. The page renders `SplitShell` when `loadResults` returns any row, else the current layout.

- [ ] **Step 2: Optimistic send**

`MessageBox` accepts `onOptimistic?: (text: string) => void`; `ThreadLive` keeps `pendingMessages: { id: string; content: string }[]` in state, appends on send (the bubble renders at once with `data-pending="true"` and the composer clears immediately), and drops them when `messages` from the server contains a user row with the same text after a refresh (or after 30 s). While a pending message exists the status line shows `Sending` then `Thinking`. If the POST fails, the pending bubble is removed and the text is restored to the box with the error. Render test: a pending message renders with the attribute; a server message with the same text replaces it (pure function `mergePending(server, pending)` in `web/components/pending.ts`, tested).

- [ ] **Step 3: Realtime**

`web/realtime.ts` already refreshes on any `messages` insert; no change. Confirm the `results` rows arrive through the same subscription (they are `messages` rows).

- [ ] **Step 4: Run, commit**

`pnpm typecheck && pnpm lint && pnpm vitest run` PASS; `pnpm build` PASS. Commit: `feat(web): Kayak split with a collapsible rail, mobile tabs, optimistic send`.

---

### Task 11: Deploy, smoke, records (controller-run)

- [ ] **Step 1:** Apply 0018 live (Task 1 did), `netlify env:list --context production` shows `JEV_KEY`; `netlify deploy --build --prod`; function log clean on an authenticated probe.
- [ ] **Step 2:** The author sends the Tokyo message on the site. Expected: within 10 s a flights list, the assumptions chips, the split layout; `only direct flights` filters in under a second with no `tool_results` insert; Choose on a flight shows hotels within 6 s; Choose on a hotel shows the pinned summary; `Get booking links` yields links (needs Anthropic credit for the reviewer; without it the proposal ships `shipped_unapproved` with the reason shown, which still proves the flow). Record timings from `model_calls.latency_ms` and `turns`.
- [ ] **Step 3:** `docs/superpowers/2026-10-03-plan-5-decisions.md` (rulings, deviations), backlog rows (5.x: side trips beyond one, children/infants in the brief, currency from origin, hotel re-rank, Jev self-consistency for low-confidence fields, the `front_desk` seat now unused), `docs/work-log.md`, `docs/deploy.md` (`JEV_KEY`). Commit `docs: plan 5 decisions, backlog, work log`.

---

## Self-review

**Spec coverage.** §1.1 Tasks 2–3; §1.2 Task 3; §1.3 Task 5; §1.4 Tasks 1, 5 (`costMicros`); §2.1 Task 9; §2.2 Tasks 6, 9; §2.3 Task 4; §2.4 Task 7; §3 Tasks 4, 8, 9; §4 Task 8; §5 Task 10; §6 Task 11 measures; §7 Tasks 1 (sentinel), 4, 9; §8 every task. The optimistic send the author asked for is Task 10 Step 2.

**Known risks for implementers.** `AgentStep`'s `park` arm: confirm its exact field names in `src/worker.ts` before Task 5; the `model_calls` NOT NULL set before Task 1 Step 6; the live project must have 0018 applied before any `withTestDb` test touches `results` rows.
