# Supplier Port and Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the supplier port with a mock and two live adapters, the provenance corpus behind it, and the deterministic gate stack that makes a proposed itinerary trustworthy — so that no price the model writes can ever reach the user.

**Architecture:** A `Supplier` port normalises three very different sources (a deterministic mock, Kiwi's MCP flight search, SearchApi's Google Hotels) into one `SupplierItem` shape carrying `Money` in minor units. Every search result is appended to `tool_results`, the untrimmed provenance corpus. `propose_itinerary` then accepts *references only* — `{sourceId, quantity, slot}` — and rehydrates every field server-side from that corpus, discarding whatever the model wrote. Six deterministic gates run over the rehydrated items, each writing a `gate_results` row.

**Tech Stack:** TypeScript (NodeNext ESM), postgres.js, zod v4, vitest, Supabase Postgres 17.

**Spec:** `docs/superpowers/specs/2026-08-15-globetrotty-design.md` — §4 (the tools), §5 (the gates), §6 (data model), §8 (cost control), §11 (testing), §13 (verified supplier facts).

**Prior plan:** `docs/superpowers/plans/2026-08-15-harness-foundation.md` (merged). Its decisions are recorded in `docs/superpowers/2026-08-16-harness-foundation-decisions.md`.

## Global Constraints

Every task's requirements implicitly include this section.

- **Money never leaves an adapter as a float.** `src/money.ts` exports `Money` (branded `{minor: bigint, currency: string}`), `money()`, `addMoney`, `sumMoney`, `compareMoney`, `formatMoney`, `minorUnitExponent`, `CurrencyMismatchError`. Suppliers hand back floats or strings; converting them to `bigint` minor units happens **once**, at the adapter boundary, and nothing downstream sees a `number` price.
- **Refuse, never convert.** Two currencies in one comparison is a violation, not a conversion problem. There is no FX rate anywhere in this codebase.
- **The harness assigns provenance; the model never does.** No tool schema in this plan accepts a `source`, `stated_by`, `price`, `currency`, `fetchedAt`, or `url` field from the model. If a model-supplied field would be trusted, the schema is wrong.
- **`import type postgres from 'postgres'`** — a default type import. `postgres` uses `export =`; there is no named `Sql` export and `import type { Sql }` does not compile.
- **`bigint` cannot be interpolated into a postgres.js template.** `Serializable` excludes it. Always `.toString()` at the call site.
- **Zod v4 reports unrecognised keys on `issue.keys`,** not `issue.path[0]`. Use `z.strictObject` / `.strict()` and read `issue.keys`.
- **Every gate outcome writes a `gate_results` row** — passes as well as failures. The table is what makes slice 2 possible; a gate that only records its failures cannot answer "how often did this fire?".
- **Secrets never enter git.** `.env.local` is gitignored and holds real values; `.env.example` carries the same keys with empty values. Never read, print, or commit `.env.local`.
- **Live-network tests are opt-in.** Adapter tests that hit Kiwi or SearchApi are guarded by an env check and skip cleanly when the key or network is absent, exactly as `describeDb` does in `test/helpers/db.ts`. The default `npm test` must pass offline.
- **Tests must fail against a wrong implementation.** Plan 1's recurring finding was tests that passed regardless. Where a test asserts an ordering, a precedence, or a discrimination, pin the specific value — not merely "it threw".

## Interfaces produced by this plan

Later tasks consume these verbatim. They are defined in Task 2 and must not drift.

```ts
// src/supplier/types.ts
export type SupplierKind = 'flight' | 'hotel'
export type PriceBasis  = 'total' | 'pre_tax'

export type LegSummary = {
  from: string; to: string
  departureLocal: string     // naive ISO, NO offset — a string, deliberately never a Date
  arrivalLocal: string
  stops: number
  route: string[]
  cabinClass: string
  carriers: string[]
}
export type FlightDetail = {
  kind: 'flight'
  outbound: LegSummary
  inbound: LegSummary | null
  baggage: { personalItem: number; cabinBag: number; checkedBag: number }
  totalDurationSeconds: number
  selfTransfer: boolean
}
export type HotelDetail = {
  kind: 'hotel'
  checkIn: string; checkOut: string; nights: number
  rating: number | null
  coordinates: { lat: number; lon: number } | null
  offerSource: string | null
}

export type SupplierItem = {
  sourceId: string
  supplier: string
  kind: SupplierKind
  name: string
  price: Money
  priceBasis: PriceBasis
  fetchedAt: Date
  ttlSeconds: number
  bookingUrl: string | null
  detail: FlightDetail | HotelDetail
}

export type FlightSearch = {
  kind: 'flight'
  from: string; to: string
  departureDate: string; returnDate: string | null   // ISO yyyy-mm-dd
  flexDays: number
  adults: number; children: number; infants: number
  cabinClass: string
  currency: string
  maxStops: number | null
  allowSelfTransfer: boolean
}
export type HotelSearch = {
  kind: 'hotel'
  query: string
  checkIn: string; checkOut: string
  adults: number
  currency: string
}
export type SearchParams = FlightSearch | HotelSearch

export type SupplierCapabilities = {
  live: boolean
  mayRequote: boolean
  maxAgeSeconds: number
  pricePersistence: 'none' | 'session' | '24h' | 'indefinite'
}

export type QuoteOutcome =
  | { status: 'ok'; item: SupplierItem }
  | { status: 'gone' }                          // searched and absent → genuinely unavailable
  | { status: 'unavailable'; reason: string }   // could not verify → BLOCKS hand-off

export interface Supplier {
  readonly name: string
  readonly kind: SupplierKind
  readonly capabilities: SupplierCapabilities
  search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]>
  quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome>
}
```

```ts
// src/gates/types.ts
export type GateName = 'provenance' | 'freshness' | 'currency' | 'totals' | 'budget' | 'dates'
export type ItemRef  = { sourceId: string; quantity: number; slot: string }
export type Violation = { gate: GateName; detail: string; sourceIds: string[] }
export type GateOutcome =
  | { ok: true;  items: RehydratedItem[]; total: Money }
  | { ok: false; violations: Violation[] }
export type RehydratedItem = { ref: ItemRef; item: SupplierItem; lineTotal: Money }
```

---

### Task 1: Migration — the provenance corpus, proposals, and gate results

**Files:**
- Create: `supabase/migrations/0004_corpus_and_proposals.sql`
- Test: `test/schema-corpus.test.ts`

**Interfaces:**
- Consumes: the nine tables from `0001_harness.sql` (notably `conversations(id, user_id)` which carries a composite unique for child FKs).
- Produces: tables `tool_results`, `proposals`, `gate_results`, `link_clicks`, `conversions`.

**Context:** `tool_results` is the corpus the gate reads. It is append-only and untrimmed — the model sees a trimmed view, the gate sees this. `(conversation_id, source_id)` is the lookup key, and it must be unique so rehydration is a point read. `conversions` is created **empty**: the join key cannot be added retroactively, but the rows arrive months after a click.

- [ ] **Step 1: Write the failing test**

```ts
// test/schema-corpus.test.ts
import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

describeDb('0004 corpus schema', () => {
  it('stores a tool result and reads it back by (conversation_id, source_id)', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000001'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      await sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'KIWI-1', 'kiwi', 'flight', 'BER-FAO',
                ${(45400n).toString()}, 'EUR', 'total', 900, ${sql.json({ a: 1 })})`
      const [row] = await sql`
        select price_minor, currency, price_basis, fetched_at
          from tool_results where conversation_id = ${c!.id} and source_id = 'KIWI-1'`
      expect(BigInt(row!.price_minor as string)).toBe(45400n)
      expect(row!.currency).toBe('EUR')
      expect(row!.fetched_at).toBeInstanceOf(Date)
    })
  })

  it('rejects a duplicate (conversation_id, source_id)', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000002'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      const ins = () => sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'DUP', 'mock', 'hotel', 'H',
                ${(100n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      await ins()
      await expect(ins()).rejects.toThrow(/duplicate key|unique/i)
    })
  })

  it('rejects a negative price and an unknown price_basis', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000003'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      await expect(sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'NEG', 'mock', 'hotel', 'H',
                ${(-1n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      ).rejects.toThrow(/check constraint/i)
      await expect(sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'BAD', 'mock', 'hotel', 'H',
                ${(1n).toString()}, 'EUR', 'wholesale', 900, ${sql.json({})})`
      ).rejects.toThrow(/check constraint/i)
    })
  })

  it('cascades tool_results and proposals when the conversation is deleted', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000004'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      await sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'X', 'mock', 'hotel', 'H',
                ${(1n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      await sql`delete from conversations where id = ${c!.id}`
      const rows = await sql`select 1 from tool_results where conversation_id = ${c!.id}`
      expect(rows.length).toBe(0)
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/schema-corpus.test.ts`
Expected: FAIL — `relation "tool_results" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0004_corpus_and_proposals.sql

-- The provenance corpus. Append-only and UNTRIMMED: the model reads a trimmed
-- view of search results, the gate reads this. Rehydration is a point read on
-- (conversation_id, source_id), so that pair is unique rather than merely indexed.
create table tool_results (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete set null,
  source_id       text not null,
  supplier        text not null,
  kind            text not null check (kind in ('flight','hotel')),
  name            text not null,
  price_minor     bigint not null check (price_minor >= 0),
  currency        char(3) not null,
  price_basis     text not null check (price_basis in ('total','pre_tax')),
  booking_url     text,
  search_params   jsonb not null default '{}'::jsonb,
  payload         jsonb not null,
  fetched_at      timestamptz not null default now(),
  ttl_seconds     int not null check (ttl_seconds > 0),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade,
  unique (conversation_id, source_id)
);
-- Rehydration reads many source_ids for one conversation in one statement.
create index tool_results_lookup on tool_results (conversation_id, fetched_at desc);

create table proposals (
  id                     uuid primary key default gen_random_uuid(),
  conversation_id        uuid not null,
  user_id                uuid not null,
  turn_id                uuid references turns(id) on delete set null,
  itinerary              jsonb not null,          -- REHYDRATED, never the model's version
  itinerary_schema_version int not null default 1,
  requirements_snapshot  jsonb not null,
  total_minor            bigint not null check (total_minor >= 0),
  currency               char(3) not null,
  gate_outcome           text not null
                           check (gate_outcome in ('approved','shipped_unapproved','rejected')),
  review_rounds          int not null default 0 check (review_rounds >= 0),
  review_issues          jsonb not null default '[]'::jsonb,
  decision               text check (decision in ('accept','reject')),
  reject_reason          text,
  decided_at             timestamptz,
  accepted_total_minor   bigint check (accepted_total_minor >= 0),
  accepted_currency      char(3),
  prompt_version         text,
  model_config_id        text,
  created_at             timestamptz not null default now(),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade,
  -- The cashier reads (id, conversation_id); a bare id would let one conversation's
  -- proposal_id be handed off from another conversation's turn.
  unique (id, conversation_id)
);
create index proposals_by_conversation on proposals (conversation_id, created_at desc);

-- Every gate outcome, pass or fail. A table that only recorded failures could not
-- answer "how often did freshness fire?", which is the question slice 2 asks first.
create table gate_results (
  id            uuid primary key default gen_random_uuid(),
  proposal_id   uuid references proposals(id) on delete cascade,
  conversation_id uuid not null,
  turn_id       uuid references turns(id) on delete set null,
  gate          text not null
                  check (gate in ('provenance','freshness','currency','totals','budget','dates','reviewer')),
  passed        boolean not null,
  round         int not null default 0 check (round >= 0),
  detail        text,
  source_ids    text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index gate_results_by_proposal on gate_results (proposal_id);
create index gate_results_by_gate on gate_results (gate, passed, created_at desc);

create table link_clicks (
  id           uuid primary key default gen_random_uuid(),
  proposal_id  uuid not null references proposals(id) on delete cascade,
  turn_id      uuid references turns(id) on delete set null,
  user_id      uuid not null,
  item_id      text not null,
  supplier     text not null,
  url          text not null,
  tracking_ref text not null unique,
  quoted_minor bigint not null check (quoted_minor >= 0),
  currency     char(3) not null,
  rendered_at  timestamptz not null default now(),
  clicked_at   timestamptz,
  unique (proposal_id, item_id)
);

-- Created EMPTY in slice 1. The join key (tracking_ref) is what cannot be added
-- later; the rows themselves arrive months after the click.
create table conversions (
  id              uuid primary key default gen_random_uuid(),
  tracking_ref    text not null,
  supplier        text not null,
  booked_at       timestamptz,
  amount_minor    bigint check (amount_minor >= 0),
  currency        char(3),
  commission_minor bigint check (commission_minor >= 0),
  reported_at     timestamptz not null default now()
);
create index conversions_by_ref on conversions (tracking_ref);

-- Same posture as 0003: no browser role reaches these tables. Policies arrive
-- with the UI in plan 4, together with a two-user isolation test.
revoke all on tool_results, proposals, gate_results, link_clicks, conversions
  from anon, authenticated;
alter table tool_results  enable row level security;
alter table proposals     enable row level security;
alter table gate_results  enable row level security;
alter table link_clicks   enable row level security;
alter table conversions   enable row level security;
```

- [ ] **Step 4: Apply and verify**

```bash
supabase db push --linked
npx vitest run test/schema-corpus.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_corpus_and_proposals.sql test/schema-corpus.test.ts
git commit -m "feat: add provenance corpus, proposals, and gate_results tables"
```

---

### Task 2: The supplier port types

**Files:**
- Create: `src/supplier/types.ts`
- Test: `test/supplier-types.test.ts`

**Interfaces:**
- Consumes: `Money` from `src/money.ts`.
- Produces: every type in the "Interfaces produced by this plan" block above, verbatim.

**Context:** This task is mostly type declarations, which tests cannot observe at runtime. What it *can* test is the one piece of behaviour that belongs here: `itemTotal(item, quantity)`, which multiplies a `Money` by an integer quantity without ever leaving `bigint`.

- [ ] **Step 1: Write the failing test**

```ts
// test/supplier-types.test.ts
import { describe, expect, it } from 'vitest'
import { money, CurrencyMismatchError } from '../src/money.js'
import { itemTotal, isFlight, isHotel } from '../src/supplier/types.js'
import type { SupplierItem } from '../src/supplier/types.js'

const flight = (over: Partial<SupplierItem> = {}): SupplierItem => ({
  sourceId: 'K1', supplier: 'kiwi', kind: 'flight', name: 'BER-FAO',
  price: money(45400n, 'EUR'), priceBasis: 'total',
  fetchedAt: new Date('2026-08-16T10:00:00Z'), ttlSeconds: 900,
  bookingUrl: 'https://kiwi.com/u/abc',
  detail: {
    kind: 'flight',
    outbound: { from: 'BER', to: 'FAO', departureLocal: '2026-09-12T16:40:00',
                arrivalLocal: '2026-09-12T23:30:00', stops: 1,
                route: ['BER', 'STN', 'FAO'], cabinClass: 'Economy', carriers: ['FR'] },
    inbound: null,
    baggage: { personalItem: 2, cabinBag: 0, checkedBag: 0 },
    totalDurationSeconds: 28200, selfTransfer: true,
  },
  ...over,
})

describe('itemTotal', () => {
  it('multiplies price by quantity in minor units', () => {
    expect(itemTotal(flight(), 3).minor).toBe(136200n)
  })

  it('rejects a non-integer or non-positive quantity', () => {
    expect(() => itemTotal(flight(), 0)).toThrow(/quantity/i)
    expect(() => itemTotal(flight(), -1)).toThrow(/quantity/i)
    expect(() => itemTotal(flight(), 1.5)).toThrow(/quantity/i)
  })

  it('preserves the currency', () => {
    expect(itemTotal(flight({ price: money(100n, 'GBP') }), 2).currency).toBe('GBP')
  })

  it('does not lose precision on a large quantity', () => {
    // A float path would go inexact well before this.
    expect(itemTotal(flight({ price: money(999999999n, 'EUR') }), 9999).minor)
      .toBe(999999999n * 9999n)
  })
})

describe('kind narrowing', () => {
  it('discriminates flight from hotel on detail.kind', () => {
    const f = flight()
    expect(isFlight(f)).toBe(true)
    expect(isHotel(f)).toBe(false)
    if (isFlight(f)) expect(f.detail.outbound.route).toEqual(['BER', 'STN', 'FAO'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/supplier-types.test.ts`
Expected: FAIL — cannot resolve `../src/supplier/types.js`.

- [ ] **Step 3: Write the implementation**

Create `src/supplier/types.ts` containing every type from the "Interfaces produced by this plan" block verbatim, plus:

```ts
import { money, type Money } from '../money.js'

/**
 * `quantity` is a count of identical units (3 seats, 7 nights), so this is
 * integer multiplication in minor units and never a float multiply. A
 * non-integer quantity is a caller bug, not a rounding question — there is no
 * correct way to charge 1.5 of a seat, so it throws rather than picking one.
 */
export function itemTotal(item: SupplierItem, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError(`itemTotal: quantity must be a positive integer, got ${quantity}`)
  }
  return money(item.price.minor * BigInt(quantity), item.price.currency)
}

export function isFlight(i: SupplierItem): i is SupplierItem & { detail: FlightDetail } {
  return i.detail.kind === 'flight'
}
export function isHotel(i: SupplierItem): i is SupplierItem & { detail: HotelDetail } {
  return i.detail.kind === 'hotel'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/supplier-types.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/supplier/types.ts test/supplier-types.test.ts
git commit -m "feat: add supplier port types and itemTotal"
```

---

### Task 3: MockSupplier

**Files:**
- Create: `src/supplier/mock.ts`
- Test: `test/supplier-mock.test.ts`

**Interfaces:**
- Consumes: `Supplier`, `SupplierItem`, `SearchParams`, `QuoteOutcome`, `SupplierCapabilities` from Task 2.
- Produces: `class MockSupplier implements Supplier`, `type MockConfig`.

**Context:** The mock is not a test fixture — it is the supplier the gates are developed against, and in slice 2 it is what lets an eval replay a conversation without touching a live API. It must be able to simulate **both** capability modes (`mayRequote` true and false), and to simulate the three quote outcomes on demand, because "a re-quote that throws blocks the hand-off" is a required test and no live API will throw when asked nicely.

- [ ] **Step 1: Write the failing test**

```ts
// test/supplier-mock.test.ts
import { describe, expect, it } from 'vitest'
import { MockSupplier } from '../src/supplier/mock.js'
import type { FlightSearch } from '../src/supplier/types.js'

const search: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO',
  departureDate: '2026-09-12', returnDate: '2026-09-19', flexDays: 0,
  adults: 2, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

describe('MockSupplier', () => {
  it('is deterministic: the same params yield the same ids and prices', async () => {
    const a = await new MockSupplier({ kind: 'flight' }).search(search)
    const b = await new MockSupplier({ kind: 'flight' }).search(search)
    expect(a.map((i) => i.sourceId)).toEqual(b.map((i) => i.sourceId))
    expect(a.map((i) => i.price.minor)).toEqual(b.map((i) => i.price.minor))
    expect(a.length).toBeGreaterThan(0)
  })

  it('varies with the params, so two searches are not silently identical', async () => {
    const a = await new MockSupplier({ kind: 'flight' }).search(search)
    const b = await new MockSupplier({ kind: 'flight' })
      .search({ ...search, to: 'LIS' })
    expect(a[0]!.sourceId).not.toBe(b[0]!.sourceId)
  })

  it('prices in the requested currency', async () => {
    const items = await new MockSupplier({ kind: 'flight' })
      .search({ ...search, currency: 'GBP' })
    expect(items.every((i) => i.price.currency === 'GBP')).toBe(true)
  })

  it('quotes an existing id as ok with the same price', async () => {
    const s = new MockSupplier({ kind: 'flight' })
    const [first] = await s.search(search)
    const q = await s.quote(first!.sourceId, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') expect(q.item.price.minor).toBe(first!.price.minor)
  })

  it('quotes an unknown id as gone', async () => {
    const s = new MockSupplier({ kind: 'flight' })
    await s.search(search)
    expect((await s.quote('no-such-id', search)).status).toBe('gone')
  })

  it('can be configured to move a price between search and quote', async () => {
    const s = new MockSupplier({ kind: 'flight', quoteDriftMinor: 5000n })
    const [first] = await s.search(search)
    const q = await s.quote(first!.sourceId, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') {
      expect(q.item.price.minor).toBe(first!.price.minor + 5000n)
    }
  })

  it('can be configured to fail a quote — unknown is not unchanged', async () => {
    const s = new MockSupplier({ kind: 'flight', quoteMode: 'throw' })
    const [first] = await s.search(search)
    await expect(s.quote(first!.sourceId, search)).rejects.toThrow()

    const u = new MockSupplier({ kind: 'flight', quoteMode: 'unavailable' })
    const [f2] = await u.search(search)
    expect((await u.quote(f2!.sourceId, search)).status).toBe('unavailable')
  })

  it('can declare itself non-requotable', () => {
    expect(new MockSupplier({ kind: 'flight', mayRequote: false })
      .capabilities.mayRequote).toBe(false)
    expect(new MockSupplier({ kind: 'flight' }).capabilities.mayRequote).toBe(true)
  })

  it('produces hotel items with nights derived from the date range', async () => {
    const items = await new MockSupplier({ kind: 'hotel' }).search({
      kind: 'hotel', query: 'Faro', checkIn: '2026-09-12',
      checkOut: '2026-09-19', adults: 2, currency: 'EUR',
    })
    expect(items[0]!.detail.kind).toBe('hotel')
    if (items[0]!.detail.kind === 'hotel') expect(items[0]!.detail.nights).toBe(7)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/supplier-mock.test.ts`
Expected: FAIL — cannot resolve `../src/supplier/mock.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/supplier/mock.ts
import { money } from '../money.js'
import type {
  Supplier, SupplierItem, SupplierKind, SearchParams, QuoteOutcome, SupplierCapabilities,
} from './types.js'

export type MockConfig = {
  kind: SupplierKind
  count?: number
  mayRequote?: boolean
  live?: boolean
  maxAgeSeconds?: number
  /** Added to every quoted price, so a cashier downgrade test has something to detect. */
  quoteDriftMinor?: bigint
  quoteMode?: 'ok' | 'throw' | 'unavailable' | 'gone'
  /** Injectable so a freshness test can age an item without sleeping. */
  now?: () => Date
}

/**
 * Deterministic by construction: prices and ids are derived from a hash of the
 * search params, so a replay in slice 2 gets byte-identical results without a
 * recorded fixture. Randomness here would make every eval flaky and every
 * failure unreproducible.
 */
export class MockSupplier implements Supplier {
  readonly name = 'mock'
  readonly kind: SupplierKind
  readonly capabilities: SupplierCapabilities
  private readonly cfg: Required<Pick<MockConfig, 'count' | 'quoteMode' | 'now'>> & MockConfig
  private lastResults = new Map<string, SupplierItem>()

  constructor(cfg: MockConfig) {
    this.kind = cfg.kind
    this.cfg = { count: 5, quoteMode: 'ok', now: () => new Date(), ...cfg }
    this.capabilities = {
      live: cfg.live ?? true,
      mayRequote: cfg.mayRequote ?? true,
      maxAgeSeconds: cfg.maxAgeSeconds ?? 900,
      pricePersistence: 'session',
    }
  }

  async search(params: SearchParams): Promise<SupplierItem[]> {
    const seed = hash(JSON.stringify(params))
    const out: SupplierItem[] = []
    for (let i = 0; i < this.cfg.count; i++) {
      const item = this.build(params, seed, i)
      this.lastResults.set(item.sourceId, item)
      out.push(item)
    }
    return out
  }

  async quote(sourceId: string, params: SearchParams): Promise<QuoteOutcome> {
    if (this.cfg.quoteMode === 'throw') throw new Error('mock supplier: quote failed')
    if (this.cfg.quoteMode === 'unavailable') {
      return { status: 'unavailable', reason: 'mock: configured unavailable' }
    }
    if (this.cfg.quoteMode === 'gone') return { status: 'gone' }
    // Rebuild from params so a quote works on a fresh instance, exactly as a
    // real re-quote does (re-run the stored search, find by native id).
    if (this.lastResults.size === 0) await this.search(params)
    const found = this.lastResults.get(sourceId)
    if (!found) return { status: 'gone' }
    const drift = this.cfg.quoteDriftMinor ?? 0n
    return {
      status: 'ok',
      item: drift === 0n ? found
        : { ...found, price: money(found.price.minor + drift, found.price.currency) },
    }
  }

  private build(params: SearchParams, seed: number, i: number): SupplierItem {
    const sourceId = `MOCK-${this.kind}-${seed.toString(16)}-${i}`
    const minor = BigInt(20_000 + ((seed + i * 7919) % 60_000))
    const base = {
      sourceId, supplier: this.name, kind: this.kind, name: `${this.kind} option ${i + 1}`,
      price: money(minor, params.currency),
      priceBasis: 'total' as const,
      fetchedAt: this.cfg.now(),
      ttlSeconds: this.capabilities.maxAgeSeconds,
      bookingUrl: `https://example.invalid/${sourceId}`,
    }
    if (params.kind === 'flight') {
      return {
        ...base,
        detail: {
          kind: 'flight',
          outbound: {
            from: params.from, to: params.to,
            departureLocal: `${params.departureDate}T08:00:00`,
            arrivalLocal: `${params.departureDate}T11:30:00`,
            stops: i % 2, route: [params.from, params.to],
            cabinClass: params.cabinClass, carriers: ['ZZ'],
          },
          inbound: params.returnDate ? {
            from: params.to, to: params.from,
            departureLocal: `${params.returnDate}T18:00:00`,
            arrivalLocal: `${params.returnDate}T21:30:00`,
            stops: i % 2, route: [params.to, params.from],
            cabinClass: params.cabinClass, carriers: ['ZZ'],
          } : null,
          baggage: { personalItem: params.adults, cabinBag: i % 2, checkedBag: i % 3 },
          totalDurationSeconds: 12_600 + i * 600,
          selfTransfer: params.allowSelfTransfer && i % 2 === 1,
        },
      }
    }
    return {
      ...base,
      detail: {
        kind: 'hotel',
        checkIn: params.checkIn, checkOut: params.checkOut,
        nights: nightsBetween(params.checkIn, params.checkOut),
        rating: 3 + (i % 3) * 0.5,
        coordinates: { lat: 37.02, lon: -7.93 },
        offerSource: 'mock.example',
      },
    }
  }
}

/** Dates only — no times, no zones. Both bounds are ISO yyyy-mm-dd. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`)
  const b = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError('nightsBetween: bad ISO date')
  return Math.round((b - a) / 86_400_000)
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/supplier-mock.test.ts && npx tsc --noEmit`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/supplier/mock.ts test/supplier-mock.test.ts
git commit -m "feat: add deterministic MockSupplier with configurable quote modes"
```

---

### Task 4: The tool_results repository

**Files:**
- Create: `src/repo/toolResults.ts`
- Test: `test/toolResults.test.ts`

**Interfaces:**
- Consumes: `SupplierItem` (Task 2), `Money` from `src/money.ts`.
- Produces:
  - `recordResults(sql, args: {conversationId, userId, turnId, params: SearchParams, items: SupplierItem[]}): Promise<number>`
  - `rehydrate(sql, conversationId: string, sourceIds: string[]): Promise<Map<string, SupplierItem>>`

**Context:** This is the corpus writer and the gate's only reader. `recordResults` is called after every supplier search and must be **idempotent on `(conversation_id, source_id)`** — a resumed turn re-running a search must not fail on a duplicate key, and must not silently overwrite the `fetched_at` the freshness gate is about to judge. Re-searching deliberately *does* refresh the row, because that is what "re-search them" means when the freshness gate asks for it; the update is therefore explicit rather than `do nothing`.

- [ ] **Step 1: Write the failing test**

```ts
// test/toolResults.test.ts
import { expect, it, describe } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults, rehydrate } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: null, flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

async function convo(sql: any, n: string) {
  const userId = `00000000-0000-4000-8000-0000000001${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  return { userId, conversationId: c!.id as string }
}

describeDb('tool_results repo', () => {
  it('records a search and rehydrates it losslessly', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '01')
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      const n = await recordResults(sql, { conversationId, userId, turnId: null, params, items })
      expect(n).toBe(items.length)

      const got = await rehydrate(sql, conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(items.length)
      const first = got.get(items[0]!.sourceId)!
      expect(first.price.minor).toBe(items[0]!.price.minor)
      expect(first.price.currency).toBe(items[0]!.price.currency)
      expect(first.name).toBe(items[0]!.name)
      expect(first.detail).toEqual(items[0]!.detail)
      expect(first.ttlSeconds).toBe(items[0]!.ttlSeconds)
      expect(first.fetchedAt).toBeInstanceOf(Date)
    })
  })

  it('is idempotent on re-record and refreshes the price and fetched_at', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '02')
      const [item] = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, { conversationId, userId, turnId: null, params, items: [item!] })
      const before = (await rehydrate(sql, conversationId, [item!.sourceId])).get(item!.sourceId)!

      const moved = { ...item!, price: money(item!.price.minor + 1000n, 'EUR') }
      await expect(recordResults(sql, {
        conversationId, userId, turnId: null, params, items: [moved],
      })).resolves.toBe(1)

      const after = (await rehydrate(sql, conversationId, [item!.sourceId])).get(item!.sourceId)!
      expect(after.price.minor).toBe(before.price.minor + 1000n)
      expect(after.fetchedAt.getTime()).toBeGreaterThanOrEqual(before.fetchedAt.getTime())
    })
  })

  it('omits ids it has never seen rather than inventing them', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '03')
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, { conversationId, userId, turnId: null, params, items })
      const got = await rehydrate(sql, conversationId, [items[0]!.sourceId, 'GHOST'])
      expect(got.has(items[0]!.sourceId)).toBe(true)
      expect(got.has('GHOST')).toBe(false)
      expect(got.size).toBe(1)
    })
  })

  it('scopes strictly to one conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await convo(sql, '04')
      const b = await convo(sql, '05')
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, { ...a, turnId: null, params, items })
      // b never searched; asking for a's ids from b's conversation must find nothing.
      const got = await rehydrate(sql, b.conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(0)
    })
  })

  it('handles an empty id list without a query', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await convo(sql, '06')
      expect((await rehydrate(sql, conversationId, [])).size).toBe(0)
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/toolResults.test.ts`
Expected: FAIL — cannot resolve `../src/repo/toolResults.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/repo/toolResults.ts
import type postgres from 'postgres'
import { money } from '../money.js'
import type { SupplierItem, SearchParams, FlightDetail, HotelDetail } from '../supplier/types.js'

type Row = {
  source_id: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  price_minor: string; currency: string; price_basis: 'total' | 'pre_tax'
  booking_url: string | null; payload: FlightDetail | HotelDetail
  fetched_at: Date; ttl_seconds: number
}

/**
 * Appends a search's results to the provenance corpus. Idempotent on
 * (conversation_id, source_id): a resumed turn that re-runs the same search
 * must not fail on a duplicate key.
 *
 * The conflict path UPDATES rather than doing nothing, deliberately. When the
 * freshness gate says "these prices are older than we'll quote, re-search
 * them", the re-search has to be able to move both the price and `fetched_at`
 * — a `do nothing` would leave the stale row in place and the gate would
 * reject the retry for exactly the reason the retry was meant to fix.
 */
export async function recordResults(
  sql: postgres.Sql,
  args: {
    conversationId: string
    userId: string
    turnId: string | null
    params: SearchParams
    items: SupplierItem[]
  },
): Promise<number> {
  if (args.items.length === 0) return 0
  const rows = args.items.map((i) => ({
    conversation_id: args.conversationId,
    user_id: args.userId,
    turn_id: args.turnId,
    source_id: i.sourceId,
    supplier: i.supplier,
    kind: i.kind,
    name: i.name,
    price_minor: i.price.minor.toString(),   // bigint is not Serializable
    currency: i.price.currency,
    price_basis: i.priceBasis,
    booking_url: i.bookingUrl,
    search_params: sql.json(args.params as never),
    payload: sql.json(i.detail as never),
    fetched_at: i.fetchedAt,
    ttl_seconds: i.ttlSeconds,
  }))
  const out = await sql`
    insert into tool_results ${sql(rows)}
    on conflict (conversation_id, source_id) do update set
      price_minor = excluded.price_minor,
      currency    = excluded.currency,
      price_basis = excluded.price_basis,
      booking_url = excluded.booking_url,
      payload     = excluded.payload,
      search_params = excluded.search_params,
      fetched_at  = excluded.fetched_at,
      ttl_seconds = excluded.ttl_seconds
    returning source_id`
  return out.length
}

/**
 * The gate's only reader. Returns a Map so a caller can tell "present" from
 * "absent" without a second query — an id that is absent is precisely the
 * provenance failure, so it must never be silently defaulted.
 *
 * Scoped to one conversation on purpose: a source id seen in someone else's
 * conversation is not provenance for this one.
 */
export async function rehydrate(
  sql: postgres.Sql,
  conversationId: string,
  sourceIds: string[],
): Promise<Map<string, SupplierItem>> {
  if (sourceIds.length === 0) return new Map()
  const rows = await sql<Row[]>`
    select source_id, supplier, kind, name, price_minor, currency, price_basis,
           booking_url, payload, fetched_at, ttl_seconds
      from tool_results
     where conversation_id = ${conversationId}
       and source_id = any(${sourceIds})`
  const out = new Map<string, SupplierItem>()
  for (const r of rows) {
    out.set(r.source_id, {
      sourceId: r.source_id,
      supplier: r.supplier,
      kind: r.kind,
      name: r.name,
      price: money(BigInt(r.price_minor), r.currency),
      priceBasis: r.price_basis,
      fetchedAt: r.fetched_at,
      ttlSeconds: r.ttl_seconds,
      bookingUrl: r.booking_url,
      detail: r.payload,
    })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/toolResults.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/toolResults.ts test/toolResults.test.ts
git commit -m "feat: add tool_results corpus writer and rehydrator"
```

---

### Task 5: Kiwi MCP adapter — search

**Files:**
- Create: `src/supplier/kiwi.ts`
- Test: `test/supplier-kiwi.test.ts`
- Test: `test/fixtures/kiwi-search.json` (captured live response, committed)

**Interfaces:**
- Consumes: `Supplier`, `SupplierItem`, `FlightSearch` (Task 2).
- Produces: `class KiwiSupplier implements Supplier`, and the exported pure function
  `parseKiwiResponse(text: string, params: FlightSearch, now: Date): SupplierItem[]`.

**Context — verified live 2026-08-16:** `POST https://mcp.kiwi.com`, JSON-RPC 2.0, no auth, no session handshake. Response is `text/event-stream`; the JSON-RPC payload is on the last `data: ` line. `result.content[0].text` is a **JSON string** that must be parsed a second time. Inside: `{query, currency, passengers, resultsCount, itineraries[], searchTimeMs, error}`.

Three hazards this task must handle, all confirmed against the live API:
1. **`price` is a JSON float** (`454.0`). It becomes `bigint` minor units exactly once, here, via `Math.round(price * 10 ** exponent)`.
2. **Leg times are naive local ISO with no offset** (`"2026-09-12T16:40:00"`). They stay **strings**. Parsing them into a `Date` applies the server's timezone and silently shifts every date-window check.
3. **`departureDate` is `dd/mm/yyyy`** on the request, while everything in our system is ISO `yyyy-mm-dd`. Convert at the boundary.

The parse is a separate pure function from the fetch so it can be tested against a committed fixture with no network.

- [ ] **Step 1: Capture the fixture**

```bash
mkdir -p test/fixtures
curl -s -X POST https://mcp.kiwi.com \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search-flight","arguments":{"flyFrom":"BER","flyTo":"FAO","departureDate":"12/09/2026","returnDate":"19/09/2026","adults":2,"currency":"EUR","limit":3}}}' \
  -m 90 -o test/fixtures/kiwi-search.sse
```

Keep the raw SSE body verbatim — the parser's first job is finding the payload inside it, so a pre-cleaned fixture would skip the step most likely to break.

- [ ] **Step 2: Write the failing test**

```ts
// test/supplier-kiwi.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKiwiResponse, toKiwiDate, KiwiSupplier } from '../src/supplier/kiwi.js'
import type { FlightSearch } from '../src/supplier/types.js'

const sse = readFileSync(new URL('./fixtures/kiwi-search.sse', import.meta.url), 'utf8')
const NOW = new Date('2026-08-16T12:00:00Z')
const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

describe('toKiwiDate', () => {
  it('converts ISO to dd/mm/yyyy', () => {
    expect(toKiwiDate('2026-09-12')).toBe('12/09/2026')
    expect(toKiwiDate('2026-01-05')).toBe('05/01/2026')
  })
  it('rejects a non-ISO input rather than guessing', () => {
    expect(() => toKiwiDate('12/09/2026')).toThrow(/ISO/i)
    expect(() => toKiwiDate('2026-9-12')).toThrow(/ISO/i)
  })
})

describe('parseKiwiResponse', () => {
  const items = parseKiwiResponse(sse, params, NOW)

  it('finds the payload inside the SSE envelope', () => {
    expect(items.length).toBeGreaterThan(0)
  })

  it('converts the float price to exact minor units', () => {
    // 454.0 EUR -> 45400n. A float path would risk 45399n.
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
    }
    expect(items.some((i) => i.price.minor % 100n === 0n)).toBe(true)
  })

  it('keeps leg times as naive strings, never Dates', () => {
    const d = items[0]!.detail
    expect(d.kind).toBe('flight')
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(typeof d.outbound.departureLocal).toBe('string')
    expect(d.outbound.departureLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(d.outbound.departureLocal).not.toMatch(/Z|[+-]\d{2}:\d{2}$/)
  })

  it('carries baggage counts through, including zeroes', () => {
    const d = items[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.baggage).toEqual(expect.objectContaining({
      personalItem: expect.any(Number), cabinBag: expect.any(Number),
      checkedBag: expect.any(Number),
    }))
  })

  it('preserves the native id verbatim so a re-quote can find it', () => {
    expect(items[0]!.sourceId.length).toBeGreaterThan(10)
    expect(items[0]!.sourceId).toContain('_')
  })

  it('stamps fetchedAt from the injected clock, not wall time', () => {
    expect(items[0]!.fetchedAt.toISOString()).toBe(NOW.toISOString())
  })

  it('records selfTransfer from the request, since the API does not echo it', () => {
    const d = items[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.selfTransfer).toBe(false)
    const allowed = parseKiwiResponse(sse, { ...params, allowSelfTransfer: true }, NOW)
    const d2 = allowed[0]!.detail
    if (d2.kind !== 'flight') throw new Error('unreachable')
    expect(d2.selfTransfer).toBe(true)
  })

  it('throws on an error payload rather than returning an empty list', () => {
    const bad = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ error: 'no route', itineraries: [] }) }] },
    })
    expect(() => parseKiwiResponse(bad, params, NOW)).toThrow(/no route/)
  })

  it('rejects a currency the response did not honour', () => {
    const wrong = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'USD', itineraries: [], resultsCount: 0,
      }) }] },
    })
    expect(() => parseKiwiResponse(wrong, { ...params, currency: 'EUR' }, NOW))
      .toThrow(/currency/i)
  })
})

describe('KiwiSupplier capabilities', () => {
  it('declares itself live and requotable', () => {
    const s = new KiwiSupplier()
    expect(s.capabilities.live).toBe(true)
    expect(s.capabilities.mayRequote).toBe(true)
    expect(s.capabilities.maxAgeSeconds).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/supplier-kiwi.test.ts`
Expected: FAIL — cannot resolve `../src/supplier/kiwi.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/supplier/kiwi.ts
import { money, minorUnitExponent } from '../money.js'
import type {
  Supplier, SupplierItem, SupplierCapabilities, SearchParams, FlightSearch,
  QuoteOutcome, LegSummary,
} from './types.js'

const ENDPOINT = 'https://mcp.kiwi.com'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Kiwi wants dd/mm/yyyy; everything in this system is ISO. Convert at the edge. */
export function toKiwiDate(iso: string): string {
  if (!ISO_DATE.test(iso)) throw new RangeError(`toKiwiDate: expected ISO yyyy-mm-dd, got ${iso}`)
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

type KiwiLeg = {
  from: string; to: string; departureTime: string; arrivalTime: string
  stops: number; route: string[]; cabinClass: string
  segments?: { carrier?: string; carrierName?: string }[]
}
type KiwiItinerary = {
  id: string; price: number; priceFormatted?: string
  totalDurationSeconds: number; bookingUrl: string | null
  baggage: { personalItem: number; cabinBag: number; checkedBag: number }
  outbound: KiwiLeg; inbound: KiwiLeg | null
}

/**
 * Pure: SSE text in, normalised items out. Separated from the fetch so the whole
 * parse is testable against a committed fixture with no network — which is also
 * the only way the float and naive-timestamp hazards below get regression cover.
 */
export function parseKiwiResponse(
  body: string, params: FlightSearch, now: Date,
): SupplierItem[] {
  const payload = extractJsonRpc(body)
  if (payload.error) throw new Error(`kiwi: JSON-RPC error ${JSON.stringify(payload.error)}`)
  const text = payload.result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('kiwi: response carried no text content')

  // The tool result is a JSON STRING inside the JSON-RPC envelope: parsed twice.
  const data = JSON.parse(text) as {
    currency?: string; itineraries?: KiwiItinerary[]; error?: unknown
  }
  if (data.error) throw new Error(`kiwi: ${String(data.error)}`)

  // Currency is a request parameter, so a mismatch means the market was scoped
  // differently than we asked. Refuse — this codebase never converts.
  if (data.currency && data.currency !== params.currency) {
    throw new Error(
      `kiwi: requested currency ${params.currency} but response is ${data.currency}`)
  }

  const exp = minorUnitExponent(params.currency)
  const scale = 10 ** exp
  return (data.itineraries ?? []).map((it) => {
    if (!Number.isFinite(it.price)) throw new Error(`kiwi: non-finite price on ${it.id}`)
    // The ONE float->bigint conversion. Round, never truncate: 454.0*100 can
    // land on 45399.999... in binary floating point and Math.trunc would lose a cent.
    const minor = BigInt(Math.round(it.price * scale))
    return {
      sourceId: it.id,
      supplier: 'kiwi',
      kind: 'flight' as const,
      name: `${it.outbound.from}-${it.outbound.to}`,
      price: money(minor, params.currency),
      priceBasis: 'total' as const,
      fetchedAt: now,
      ttlSeconds: KIWI_CAPABILITIES.maxAgeSeconds,
      bookingUrl: it.bookingUrl ?? null,
      detail: {
        kind: 'flight' as const,
        outbound: leg(it.outbound),
        inbound: it.inbound ? leg(it.inbound) : null,
        baggage: it.baggage,
        totalDurationSeconds: it.totalDurationSeconds,
        // The API does not echo allow_self_transfer, so it is recorded from the
        // request. Kiwi's virtual interlining defaults to TRUE: a missed
        // connection is the traveller's problem, and the card must say so.
        selfTransfer: params.allowSelfTransfer,
      },
    }
  })
}

/**
 * Times arrive as naive local ISO with no offset ("2026-09-12T16:40:00"). They
 * stay strings. `new Date(...)` on one of these applies the SERVER's timezone,
 * which silently shifts every downstream date-window comparison by hours.
 */
function leg(l: KiwiLeg): LegSummary {
  return {
    from: l.from, to: l.to,
    departureLocal: l.departureTime, arrivalLocal: l.arrivalTime,
    stops: l.stops, route: l.route, cabinClass: l.cabinClass,
    carriers: [...new Set((l.segments ?? []).map((s) => s.carrier ?? s.carrierName ?? '')
      .filter(Boolean))],
  }
}

type JsonRpc = { result?: { content?: { text?: string }[] }; error?: unknown }

/** The response is text/event-stream; the payload is the last `data:` line. */
function extractJsonRpc(body: string): JsonRpc {
  const lines = body.split('\n').filter((l) => l.startsWith('data: '))
  const raw = lines.length > 0 ? lines[lines.length - 1]!.slice(6) : body
  return JSON.parse(raw) as JsonRpc
}

export const KIWI_CAPABILITIES: SupplierCapabilities = {
  live: true,
  // Verified: itinerary ids are stable across repeated identical searches
  // (15/15 matched on id and price), so quote() is a real re-search-and-find.
  mayRequote: true,
  maxAgeSeconds: 900,
  pricePersistence: 'session',
}

export class KiwiSupplier implements Supplier {
  readonly name = 'kiwi'
  readonly kind = 'flight' as const
  readonly capabilities = KIWI_CAPABILITIES
  constructor(private readonly now: () => Date = () => new Date()) {}

  async search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]> {
    if (params.kind !== 'flight') throw new TypeError('KiwiSupplier: flight searches only')
    const body = await this.call(params, signal)
    return parseKiwiResponse(body, params, this.now())
  }

  /**
   * Re-runs the stored search and finds the itinerary by its native id. An id
   * that is absent means the fare is gone; a transport failure means we could
   * not verify — and unknown is NOT unchanged, so that surfaces as
   * `unavailable` and blocks the hand-off rather than passing quietly.
   */
  async quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome> {
    if (params.kind !== 'flight') throw new TypeError('KiwiSupplier: flight searches only')
    let items: SupplierItem[]
    try {
      items = await this.search(params, signal)
    } catch (err) {
      return { status: 'unavailable', reason: `kiwi re-quote failed: ${String(err)}` }
    }
    const found = items.find((i) => i.sourceId === sourceId)
    return found ? { status: 'ok', item: found } : { status: 'gone' }
  }

  private async call(p: FlightSearch, signal?: AbortSignal): Promise<string> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 accept: 'application/json, text/event-stream' },
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'search-flight',
          arguments: {
            flyFrom: p.from, flyTo: p.to,
            departureDate: toKiwiDate(p.departureDate),
            departureDateFlexDays: p.flexDays,
            ...(p.returnDate
              ? { returnDate: toKiwiDate(p.returnDate), returnDateFlexDays: p.flexDays }
              : {}),
            adults: p.adults, children: p.children, infants: p.infants,
            cabinClass: p.cabinClass, currency: p.currency,
            ...(p.maxStops !== null ? { max_sector_stopovers: p.maxStops } : {}),
            allow_self_transfer: p.allowSelfTransfer,
          },
        },
      }),
    })
    if (!res.ok) throw new Error(`kiwi: HTTP ${res.status}`)
    return await res.text()
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/supplier-kiwi.test.ts && npx tsc --noEmit`
Expected: PASS (11 tests), all offline against the fixture.

- [ ] **Step 6: Commit**

```bash
git add src/supplier/kiwi.ts test/supplier-kiwi.test.ts test/fixtures/kiwi-search.sse
git commit -m "feat: add Kiwi MCP flight adapter with float and naive-time handling"
```

---

### Task 6: Kiwi adapter — live smoke test

**Files:**
- Create: `test/supplier-kiwi.live.test.ts`

**Interfaces:**
- Consumes: `KiwiSupplier` (Task 5).
- Produces: nothing importable — this is a guarded live check.

**Context:** The fixture proves the parser. It cannot prove the endpoint still behaves, and a fixture silently rotting is how an adapter passes its whole suite while being broken in production. This test hits the network, is skipped unless `LIVE_SUPPLIERS=1`, and must never run in the default `npm test`.

- [ ] **Step 1: Write the test**

```ts
// test/supplier-kiwi.live.test.ts
import { describe, expect, it } from 'vitest'
import { KiwiSupplier } from '../src/supplier/kiwi.js'
import type { FlightSearch } from '../src/supplier/types.js'

const live = process.env.LIVE_SUPPLIERS === '1' ? describe : describe.skip

// Kept comfortably in the future so the search never goes empty as time passes.
const departureDate = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
const returnDate = new Date(Date.now() + 67 * 86_400_000).toISOString().slice(0, 10)

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate, returnDate, flexDays: 0,
  adults: 1, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

live('KiwiSupplier (live)', () => {
  it('returns priced itineraries in the requested currency', async () => {
    const items = await new KiwiSupplier().search(params)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.price.currency === 'EUR')).toBe(true)
    expect(items.every((i) => i.price.minor > 0n)).toBe(true)
  }, 90_000)

  it('re-quotes a just-searched id to ok — the property mayRequote claims', async () => {
    const s = new KiwiSupplier()
    const [first] = await s.search(params)
    const q = await s.quote(first!.sourceId, params)
    expect(q.status).toBe('ok')
  }, 180_000)

  it('reports an unknown id as gone, not as an error', async () => {
    const q = await new KiwiSupplier().quote('definitely-not-an-itinerary', params)
    expect(q.status).toBe('gone')
  }, 90_000)
})
```

- [ ] **Step 2: Verify it skips by default**

Run: `npx vitest run test/supplier-kiwi.live.test.ts`
Expected: 3 skipped, 0 failed.

- [ ] **Step 3: Verify it passes live**

Run: `LIVE_SUPPLIERS=1 npx vitest run test/supplier-kiwi.live.test.ts`
Expected: PASS (3 tests). If the endpoint has changed shape, this is the failure that says so — re-capture the fixture in Task 5 and fix the parser.

- [ ] **Step 4: Commit**

```bash
git add test/supplier-kiwi.live.test.ts
git commit -m "test: add opt-in live Kiwi smoke test"
```

---

### Task 7: SearchApi Google Hotels adapter

**Files:**
- Create: `src/supplier/searchapi.ts`
- Test: `test/supplier-searchapi.test.ts`
- Test: `test/fixtures/searchapi-hotels.json`
- Modify: `.env.example` (add `GOOGLE_SEARCH_API=`)

**Interfaces:**
- Consumes: `Supplier`, `HotelSearch` (Task 2), `nightsBetween` from `src/supplier/mock.ts`.
- Produces: `class SearchApiHotels implements Supplier`, `parseSearchApiHotels(json, params, now): SupplierItem[]`.

**Context — verified live 2026-08-16:** `GET https://www.searchapi.io/api/v1/search` with `engine=google_hotels`, `q`, `check_in_date`, `check_out_date`, `adults`, `currency`, `api_key`. Response `{search_metadata, search_parameters, properties[], ...}`. Each property carries `property_token` (stable), `name`, `link`, `gps_coordinates`, `rating`, and **both** `total_price` and `price_per_night`, each shaped `{price: "€452", extracted_price: 452, price_before_taxes: "€428", extracted_price_before_taxes: 428}`.

**The decision this task must get right:** we take `total_price.extracted_price` and record `priceBasis: 'total'`. Some properties return only `price_before_taxes`; those record `priceBasis: 'pre_tax'` so the totals gate can refuse to mix bases. A property with neither is **dropped**, not defaulted to zero — a free hotel is the most attractive thing in any budget comparison, so a missing price must never become `0`.

- [ ] **Step 1: Capture the fixture**

```bash
set -a; . ./.env.local; set +a
curl -s -G "https://www.searchapi.io/api/v1/search" \
  --data-urlencode "engine=google_hotels" --data-urlencode "q=Faro Portugal" \
  --data-urlencode "check_in_date=2026-09-12" --data-urlencode "check_out_date=2026-09-19" \
  --data-urlencode "adults=2" --data-urlencode "currency=EUR" \
  --data-urlencode "api_key=$GOOGLE_SEARCH_API" \
  -o test/fixtures/searchapi-hotels.json -m 60
```

Then confirm no key leaked into the fixture:

```bash
grep -c "api_key" test/fixtures/searchapi-hotels.json || true
python3 - <<'PY'
import json
d = json.load(open('test/fixtures/searchapi-hotels.json'))
for k in ('search_metadata', 'search_parameters'):
    d.pop(k, None)          # request echo can carry the key
json.dump(d, open('test/fixtures/searchapi-hotels.json', 'w'), indent=1)
print('stripped request echo; properties:', len(d.get('properties', [])))
PY
```

- [ ] **Step 2: Write the failing test**

```ts
// test/supplier-searchapi.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSearchApiHotels, SearchApiHotels } from '../src/supplier/searchapi.js'
import type { HotelSearch } from '../src/supplier/types.js'

const raw = readFileSync(new URL('./fixtures/searchapi-hotels.json', import.meta.url), 'utf8')
const NOW = new Date('2026-08-16T12:00:00Z')
const params: HotelSearch = {
  kind: 'hotel', query: 'Faro Portugal', checkIn: '2026-09-12',
  checkOut: '2026-09-19', adults: 2, currency: 'EUR',
}

describe('parseSearchApiHotels', () => {
  const items = parseSearchApiHotels(raw, params, NOW)

  it('returns priced hotel items', () => {
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.kind === 'hotel')).toBe(true)
    expect(items.every((i) => i.price.minor > 0n)).toBe(true)
  })

  it('uses property_token as the source id so a re-quote can find it', () => {
    expect(items.every((i) => i.sourceId.length > 5)).toBe(true)
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(items.length)
  })

  it('records the price basis it actually read', () => {
    expect(items.every((i) => i.priceBasis === 'total' || i.priceBasis === 'pre_tax')).toBe(true)
  })

  it('derives nights from the search window', () => {
    const d = items[0]!.detail
    expect(d.kind).toBe('hotel')
    if (d.kind !== 'hotel') throw new Error('unreachable')
    expect(d.nights).toBe(7)
    expect(d.checkIn).toBe('2026-09-12')
  })

  it('DROPS a property with no usable price instead of defaulting to zero', () => {
    const doc = JSON.stringify({
      properties: [
        { property_token: 'A', name: 'Priced', total_price: { extracted_price: 100 } },
        { property_token: 'B', name: 'No price at all' },
        { property_token: 'C', name: 'Null price', total_price: { extracted_price: null } },
      ],
    })
    const out = parseSearchApiHotels(doc, params, NOW)
    expect(out.map((i) => i.sourceId)).toEqual(['A'])
    expect(out.some((i) => i.price.minor === 0n)).toBe(false)
  })

  it('falls back to pre-tax and labels it, rather than silently mixing bases', () => {
    const doc = JSON.stringify({
      properties: [{
        property_token: 'D', name: 'Pretax only',
        total_price: { extracted_price_before_taxes: 428 },
      }],
    })
    const [only] = parseSearchApiHotels(doc, params, NOW)
    expect(only!.price.minor).toBe(42800n)
    expect(only!.priceBasis).toBe('pre_tax')
  })

  it('converts the float price to exact minor units', () => {
    const doc = JSON.stringify({
      properties: [{ property_token: 'E', name: 'X', total_price: { extracted_price: 452.35 } }],
    })
    expect(parseSearchApiHotels(doc, params, NOW)[0]!.price.minor).toBe(45235n)
  })

  it('throws on an API error payload', () => {
    expect(() => parseSearchApiHotels(JSON.stringify({ error: 'bad key' }), params, NOW))
      .toThrow(/bad key/)
  })
})

describe('SearchApiHotels capabilities', () => {
  it('is live and requotable via the stable property token', () => {
    const s = new SearchApiHotels('test-key')
    expect(s.capabilities.live).toBe(true)
    expect(s.capabilities.mayRequote).toBe(true)
  })
  it('refuses to construct without a key rather than failing at request time', () => {
    expect(() => new SearchApiHotels('')).toThrow(/key/i)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/supplier-searchapi.test.ts`
Expected: FAIL — cannot resolve `../src/supplier/searchapi.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/supplier/searchapi.ts
import { money, minorUnitExponent } from '../money.js'
import { nightsBetween } from './mock.js'
import type {
  Supplier, SupplierItem, SupplierCapabilities, SearchParams, HotelSearch,
  QuoteOutcome, PriceBasis,
} from './types.js'

const ENDPOINT = 'https://www.searchapi.io/api/v1/search'

type Price = {
  extracted_price?: number | null
  extracted_price_before_taxes?: number | null
}
type Property = {
  property_token?: string; name?: string; link?: string
  gps_coordinates?: { latitude: number; longitude: number }
  rating?: number; total_price?: Price; price_per_night?: Price
  offers?: { source?: string }[]
}

export const SEARCHAPI_CAPABILITIES: SupplierCapabilities = {
  live: true,
  // property_token is stable across searches, so a re-quote is a re-search
  // plus a find — the same shape as Kiwi's.
  mayRequote: true,
  maxAgeSeconds: 3600,
  pricePersistence: 'session',
}

/**
 * Pure: raw JSON text in, normalised items out.
 *
 * Price selection is the load-bearing decision. We prefer the all-in
 * `total_price`, fall back to the pre-tax figure and LABEL it, and drop a
 * property that offers neither. Defaulting a missing price to zero would make
 * the unpriced hotel the cheapest option in every budget comparison — the most
 * attractive possible answer, and entirely fictional.
 */
export function parseSearchApiHotels(
  body: string, params: HotelSearch, now: Date,
): SupplierItem[] {
  const data = JSON.parse(body) as { properties?: Property[]; error?: unknown }
  if (data.error) throw new Error(`searchapi: ${String(data.error)}`)

  const exp = minorUnitExponent(params.currency)
  const scale = 10 ** exp
  const nights = nightsBetween(params.checkIn, params.checkOut)
  const out: SupplierItem[] = []

  for (const p of data.properties ?? []) {
    const token = p.property_token
    if (!token) continue
    const picked = pickPrice(p)
    if (!picked) continue                       // no usable price -> drop, never default

    out.push({
      sourceId: token,
      supplier: 'searchapi',
      kind: 'hotel',
      name: p.name ?? token,
      price: money(BigInt(Math.round(picked.amount * scale)), params.currency),
      priceBasis: picked.basis,
      fetchedAt: now,
      ttlSeconds: SEARCHAPI_CAPABILITIES.maxAgeSeconds,
      // Supplier-supplied and therefore untrusted: §10's host allowlist applies
      // before this is ever emitted to the user.
      bookingUrl: p.link ?? null,
      detail: {
        kind: 'hotel',
        checkIn: params.checkIn, checkOut: params.checkOut, nights,
        rating: typeof p.rating === 'number' ? p.rating : null,
        coordinates: p.gps_coordinates
          ? { lat: p.gps_coordinates.latitude, lon: p.gps_coordinates.longitude }
          : null,
        offerSource: p.offers?.[0]?.source ?? null,
      },
    })
  }
  return out
}

function pickPrice(p: Property): { amount: number; basis: PriceBasis } | null {
  const total = p.total_price?.extracted_price
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return { amount: total, basis: 'total' }
  }
  const pre = p.total_price?.extracted_price_before_taxes
  if (typeof pre === 'number' && Number.isFinite(pre) && pre > 0) {
    return { amount: pre, basis: 'pre_tax' }
  }
  return null
}

export class SearchApiHotels implements Supplier {
  readonly name = 'searchapi'
  readonly kind = 'hotel' as const
  readonly capabilities = SEARCHAPI_CAPABILITIES

  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    // Fail at construction, not at request time: a missing key discovered
    // mid-turn costs a turn, discovered at boot costs a restart.
    if (!apiKey) throw new Error('SearchApiHotels: api key is required')
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]> {
    if (params.kind !== 'hotel') throw new TypeError('SearchApiHotels: hotel searches only')
    const url = new URL(ENDPOINT)
    url.searchParams.set('engine', 'google_hotels')
    url.searchParams.set('q', params.query)
    url.searchParams.set('check_in_date', params.checkIn)
    url.searchParams.set('check_out_date', params.checkOut)
    url.searchParams.set('adults', String(params.adults))
    url.searchParams.set('currency', params.currency)
    url.searchParams.set('api_key', this.apiKey)

    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`searchapi: HTTP ${res.status}`)
    return parseSearchApiHotels(await res.text(), params, this.now())
  }

  async quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome> {
    if (params.kind !== 'hotel') throw new TypeError('SearchApiHotels: hotel searches only')
    let items: SupplierItem[]
    try {
      items = await this.search(params, signal)
    } catch (err) {
      return { status: 'unavailable', reason: `searchapi re-quote failed: ${String(err)}` }
    }
    const found = items.find((i) => i.sourceId === sourceId)
    return found ? { status: 'ok', item: found } : { status: 'gone' }
  }
}
```

- [ ] **Step 5: Add the key to `.env.example`**

Append `GOOGLE_SEARCH_API=` (empty value) to `.env.example`. Do not touch `.env.local`.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/supplier-searchapi.test.ts && npx tsc --noEmit`
Expected: PASS (10 tests).

- [ ] **Step 7: Commit**

```bash
git add src/supplier/searchapi.ts test/supplier-searchapi.test.ts \
        test/fixtures/searchapi-hotels.json .env.example
git commit -m "feat: add SearchApi Google Hotels adapter with explicit price basis"
```

---

### Task 8: The rehydration gate

**Files:**
- Create: `src/gates/types.ts`
- Create: `src/gates/rehydrateGate.ts`
- Test: `test/gate-rehydrate.test.ts`

**Interfaces:**
- Consumes: `rehydrate` (Task 4), `SupplierItem`, `itemTotal` (Task 2).
- Produces: `rehydrateRefs(sql, conversationId, refs): Promise<RehydrateResult>` where
  `RehydrateResult = {ok: true, items: RehydratedItem[]} | {ok: false, violations: Violation[]}`,
  plus the zod schema `ProposalRefsSchema`.

**Context — this is the most important task in the plan.** The articles' `checkProvenance` validates that a `sourceId` was seen and never checks the values attached to it, so a model can cite a real hotel with a real id and attach an invented price. The fix is structural, not an extra check: **the tool schema has no price field at all.** The model sends `{sourceId, quantity, slot}`; every other field is read from `tool_results`. There is nothing to tamper with.

The test that proves this is the single most valuable test in the suite: a payload carrying a real `sourceId` **and** an extra `price` key must be rejected by the schema outright, and the rehydrated item must carry the corpus price regardless.

- [ ] **Step 1: Write the failing test**

```ts
// test/gate-rehydrate.test.ts
import { expect, it, describe } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults } from '../src/repo/toolResults.js'
import { rehydrateRefs, ProposalRefsSchema } from '../src/gates/rehydrateGate.js'
import { MockSupplier } from '../src/supplier/mock.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: null, flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

async function seed(sql: any, n: string) {
  const userId = `00000000-0000-4000-8000-0000000002${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const conversationId = c!.id as string
  const items = await new MockSupplier({ kind: 'flight' }).search(params)
  await recordResults(sql, { conversationId, userId, turnId: null, params, items })
  return { userId, conversationId, items }
}

describe('ProposalRefsSchema — the model cannot send values', () => {
  it('accepts a bare reference', () => {
    const r = ProposalRefsSchema.safeParse({
      refs: [{ sourceId: 'K1', quantity: 1, slot: 'outbound' }],
    })
    expect(r.success).toBe(true)
  })

  it('REJECTS a payload carrying a price — the tampering case', () => {
    const r = ProposalRefsSchema.safeParse({
      refs: [{ sourceId: 'K1', quantity: 1, slot: 'outbound', price: 8900, currency: 'EUR' }],
    })
    expect(r.success).toBe(false)
    // zod v4 reports unrecognised keys on issue.keys, NOT issue.path[0].
    const keys = r.success ? [] : r.error.issues.flatMap((i: any) => i.keys ?? [])
    expect(keys).toContain('price')
  })

  it('rejects a non-positive or non-integer quantity', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(ProposalRefsSchema.safeParse({
        refs: [{ sourceId: 'K1', quantity, slot: 'x' }],
      }).success).toBe(false)
    }
  })

  it('rejects an empty ref list', () => {
    expect(ProposalRefsSchema.safeParse({ refs: [] }).success).toBe(false)
  })

  it('rejects duplicate sourceIds in one proposal', () => {
    expect(ProposalRefsSchema.safeParse({
      refs: [{ sourceId: 'A', quantity: 1, slot: 'x' },
             { sourceId: 'A', quantity: 1, slot: 'y' }],
    }).success).toBe(false)
  })
})

describeDb('rehydrateRefs', () => {
  it('returns corpus values, not anything the caller supplied', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '01')
      const res = await rehydrateRefs(sql, conversationId, [
        { sourceId: items[0]!.sourceId, quantity: 2, slot: 'outbound' },
      ])
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      expect(res.items[0]!.item.price.minor).toBe(items[0]!.price.minor)
      expect(res.items[0]!.lineTotal.minor).toBe(items[0]!.price.minor * 2n)
    })
  })

  it('fails provenance for an id the corpus never saw', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '02')
      const res = await rehydrateRefs(sql, conversationId, [
        { sourceId: items[0]!.sourceId, quantity: 1, slot: 'a' },
        { sourceId: 'HALLUCINATED-42', quantity: 1, slot: 'b' },
      ])
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations).toHaveLength(1)
      expect(res.violations[0]!.gate).toBe('provenance')
      expect(res.violations[0]!.sourceIds).toEqual(['HALLUCINATED-42'])
      // The message must name the offending id so the model can act on it.
      expect(res.violations[0]!.detail).toContain('HALLUCINATED-42')
    })
  })

  it('does not accept an id belonging to another conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '03')
      const b = await seed(sql, '04')
      const res = await rehydrateRefs(sql, b.conversationId, [
        { sourceId: a.items[0]!.sourceId, quantity: 1, slot: 'a' },
      ])
      expect(res.ok).toBe(false)
    })
  })

  it('reports every missing id at once, not just the first', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, '05')
      const res = await rehydrateRefs(sql, conversationId, [
        { sourceId: 'X1', quantity: 1, slot: 'a' },
        { sourceId: 'X2', quantity: 1, slot: 'b' },
      ])
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations[0]!.sourceIds.sort()).toEqual(['X1', 'X2'])
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/gate-rehydrate.test.ts`
Expected: FAIL — cannot resolve `../src/gates/rehydrateGate.js`.

- [ ] **Step 3: Write `src/gates/types.ts`**

Contains the `GateName`, `ItemRef`, `Violation`, `RehydratedItem`, `GateOutcome` types from the interfaces block above.

- [ ] **Step 4: Write the implementation**

```ts
// src/gates/rehydrateGate.ts
import { z } from 'zod'
import type postgres from 'postgres'
import { rehydrate } from '../repo/toolResults.js'
import { itemTotal } from '../supplier/types.js'
import type { ItemRef, RehydratedItem, Violation } from './types.js'

/**
 * The model may send references and NOTHING ELSE.
 *
 * This is the structural fix for the flaw the source articles' `checkProvenance`
 * carries: that version validates that a sourceId was SEEN and never checks the
 * values attached to it, so a model can cite a genuine hotel with a genuine id,
 * attach an invented €89/night, pass provenance, and have the budget check then
 * validate the invented number.
 *
 * There is no price field here to tamper with. `.strict()` makes an attempt to
 * supply one a hard parse failure rather than a silently ignored key — ignoring
 * it would work, but it would also hide the fact that the model tried, and that
 * attempt is a signal worth surfacing.
 *
 * Provenance defends against hallucination, not against an adversary who is
 * legitimately in the supplier's index.
 */
export const ProposalRefsSchema = z.strictObject({
  refs: z.array(z.strictObject({
    sourceId: z.string().min(1).max(512),
    quantity: z.int().positive(),
    slot: z.string().min(1).max(64),
  })).min(1).max(24)
    .refine(
      (refs) => new Set(refs.map((r) => r.sourceId)).size === refs.length,
      { message: 'duplicate sourceId in one proposal' },
    ),
})

export type RehydrateResult =
  | { ok: true; items: RehydratedItem[] }
  | { ok: false; violations: Violation[] }

/**
 * Reads every referenced item from the corpus and discards whatever the caller
 * thought those items were. Scoped to one conversation: an id seen in someone
 * else's conversation is not provenance for this one.
 */
export async function rehydrateRefs(
  sql: postgres.Sql,
  conversationId: string,
  refs: ItemRef[],
): Promise<RehydrateResult> {
  const found = await rehydrate(sql, conversationId, refs.map((r) => r.sourceId))

  // Report ALL missing ids together. One-at-a-time rejection costs a model round
  // trip per bad reference, and the model cannot see the pattern in its own error.
  const missing = refs.filter((r) => !found.has(r.sourceId)).map((r) => r.sourceId)
  if (missing.length > 0) {
    return {
      ok: false,
      violations: [{
        gate: 'provenance',
        sourceIds: missing,
        detail: `These items match no search result in this conversation: ${missing.join(', ')}. `
              + `Search for them first, then propose the ids the search returned.`,
      }],
    }
  }

  return {
    ok: true,
    items: refs.map((ref) => {
      const item = found.get(ref.sourceId)!
      return { ref, item, lineTotal: itemTotal(item, ref.quantity) }
    }),
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/gate-rehydrate.test.ts && npx tsc --noEmit`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/gates/types.ts src/gates/rehydrateGate.ts test/gate-rehydrate.test.ts
git commit -m "feat: add rehydration gate — the model sends refs, never values"
```

---

### Task 9: Freshness and currency gates

**Files:**
- Create: `src/gates/checks.ts`
- Test: `test/gate-freshness-currency.test.ts`

**Interfaces:**
- Consumes: `RehydratedItem`, `Violation` (Task 8).
- Produces: `checkFreshness(items, now): Violation[]`, `checkCurrency(items, expected): Violation[]`.

**Context:** Freshness compares `fetchedAt + ttlSeconds` against an **injected** clock — never `Date.now()` inside the function, or the test has to sleep and the eval replay in slice 2 becomes unreproducible. Currency refuses; it never converts. Two currencies among the items is a violation even when both differ from the notebook's, because the totals gate downstream cannot sum them either.

- [ ] **Step 1: Write the failing test**

```ts
// test/gate-freshness-currency.test.ts
import { describe, expect, it } from 'vitest'
import { checkFreshness, checkCurrency } from '../src/gates/checks.js'
import { money } from '../src/money.js'
import type { RehydratedItem } from '../src/gates/types.js'
import type { SupplierItem } from '../src/supplier/types.js'

const NOW = new Date('2026-08-16T12:00:00Z')

function item(over: Partial<SupplierItem> = {}, quantity = 1): RehydratedItem {
  const it: SupplierItem = {
    sourceId: over.sourceId ?? 'S1', supplier: 'mock', kind: 'hotel', name: 'H',
    price: over.price ?? money(10_000n, 'EUR'), priceBasis: 'total',
    fetchedAt: over.fetchedAt ?? new Date('2026-08-16T11:55:00Z'),
    ttlSeconds: over.ttlSeconds ?? 900, bookingUrl: null,
    detail: { kind: 'hotel', checkIn: '2026-09-12', checkOut: '2026-09-19',
              nights: 7, rating: null, coordinates: null, offerSource: null },
    ...over,
  }
  return { ref: { sourceId: it.sourceId, quantity, slot: 'a' }, item: it,
           lineTotal: money(it.price.minor * BigInt(quantity), it.price.currency) }
}

describe('checkFreshness', () => {
  it('passes an item inside its TTL', () => {
    expect(checkFreshness([item()], NOW)).toEqual([])
  })

  it('fails an item past its TTL and names it', () => {
    const stale = item({ sourceId: 'OLD', fetchedAt: new Date('2026-08-16T11:00:00Z'), ttlSeconds: 900 })
    const v = checkFreshness([stale], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('freshness')
    expect(v[0]!.sourceIds).toEqual(['OLD'])
    expect(v[0]!.detail).toMatch(/re-?search/i)
  })

  it('is exact at the boundary: ttl elapsed exactly is still fresh', () => {
    const edge = item({ fetchedAt: new Date(NOW.getTime() - 900_000), ttlSeconds: 900 })
    expect(checkFreshness([edge], NOW)).toEqual([])
    const over = item({ fetchedAt: new Date(NOW.getTime() - 900_001), ttlSeconds: 900 })
    expect(checkFreshness([over], NOW)).toHaveLength(1)
  })

  it('uses each item\'s own TTL, not a shared constant', () => {
    const shortTtl = item({ sourceId: 'SHORT', fetchedAt: new Date(NOW.getTime() - 400_000), ttlSeconds: 300 })
    const longTtl  = item({ sourceId: 'LONG',  fetchedAt: new Date(NOW.getTime() - 400_000), ttlSeconds: 3600 })
    const v = checkFreshness([shortTtl, longTtl], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['SHORT'])
  })

  it('groups every stale item into one violation', () => {
    const a = item({ sourceId: 'A', fetchedAt: new Date('2026-08-16T10:00:00Z') })
    const b = item({ sourceId: 'B', fetchedAt: new Date('2026-08-16T10:00:00Z') })
    const v = checkFreshness([a, b], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds.sort()).toEqual(['A', 'B'])
  })

  it('rejects an item stamped in the future rather than treating it as fresh', () => {
    const v = checkFreshness([item({ sourceId: 'FUTURE', fetchedAt: new Date(NOW.getTime() + 60_000) })], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['FUTURE'])
  })
})

describe('checkCurrency', () => {
  it('passes when every item matches the expected currency', () => {
    expect(checkCurrency([item(), item({ sourceId: 'S2' })], 'EUR')).toEqual([])
  })

  it('fails an item in a different currency and never converts', () => {
    const gbp = item({ sourceId: 'GBP1', price: money(9_000n, 'GBP') })
    const v = checkCurrency([item(), gbp], 'EUR')
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('currency')
    expect(v[0]!.sourceIds).toEqual(['GBP1'])
    expect(v[0]!.detail).not.toMatch(/convert|exchange|rate/i)
  })

  it('fails a mixed-currency set even when the expected currency is absent', () => {
    const a = item({ sourceId: 'A', price: money(1n, 'GBP') })
    const b = item({ sourceId: 'B', price: money(1n, 'USD') })
    expect(checkCurrency([a, b], 'EUR')).not.toEqual([])
  })

  it('passes an empty set', () => {
    expect(checkCurrency([], 'EUR')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/gate-freshness-currency.test.ts`
Expected: FAIL — cannot resolve `../src/gates/checks.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/gates/checks.ts
import type { RehydratedItem, Violation } from './types.js'

/**
 * `now` is injected, never read from the clock inside. Two reasons: a test
 * would otherwise have to sleep past a TTL, and slice 2's replay has to be able
 * to re-judge a recorded conversation at the instant it originally ran.
 *
 * An item stamped in the FUTURE fails too. That is not pedantry — a future
 * `fetched_at` means a clock disagreement somewhere, and the one thing we must
 * not do with a timestamp we cannot trust is treat it as reassuring.
 */
export function checkFreshness(items: RehydratedItem[], now: Date): Violation[] {
  const bad = items.filter(({ item }) => {
    const age = now.getTime() - item.fetchedAt.getTime()
    return age < 0 || age > item.ttlSeconds * 1000
  })
  if (bad.length === 0) return []
  return [{
    gate: 'freshness',
    sourceIds: bad.map((b) => b.item.sourceId),
    detail: `These prices are older than we will quote: `
          + `${bad.map((b) => b.item.sourceId).join(', ')}. Re-search them and propose the new ids.`,
  }]
}

/**
 * Refuses; never converts. There is no FX rate in this codebase, deliberately —
 * a converted price is a price we made up, and the whole point of the gate
 * stack is that every number the user sees came from a supplier.
 *
 * A mixed set fails even when NO item matches the expected currency, because
 * the totals gate downstream cannot sum two currencies either.
 */
export function checkCurrency(items: RehydratedItem[], expected: string): Violation[] {
  const bad = items.filter(({ item }) => item.price.currency !== expected)
  if (bad.length === 0) return []
  const seen = [...new Set(items.map((i) => i.item.price.currency))]
  return [{
    gate: 'currency',
    sourceIds: bad.map((b) => b.item.sourceId),
    detail: `This trip is priced in ${expected}, but these items are not: `
          + `${bad.map((b) => `${b.item.sourceId} (${b.item.price.currency})`).join(', ')}. `
          + `Search again with currency=${expected}. `
          + `Currencies present: ${seen.join(', ')}.`,
  }]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/gate-freshness-currency.test.ts && npx tsc --noEmit`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gates/checks.ts test/gate-freshness-currency.test.ts
git commit -m "feat: add freshness and currency gates with an injected clock"
```

---

### Task 10: Totals, budget, and dates gates

**Files:**
- Modify: `src/gates/checks.ts`
- Test: `test/gate-totals-budget-dates.test.ts`

**Interfaces:**
- Consumes: `RehydratedItem`, `Violation`, `Money`, `sumMoney`, `compareMoney`.
- Produces: `checkTotals(items): {violations: Violation[]; total: Money | null}`,
  `checkBudget(items, budget): Violation[]`, `checkDates(items, window): Violation[]`,
  `type DateWindow = {earliest: string; latest: string}`.

**Context:** `checkTotals` computes the sum **server-side** and is the only thing that ever produces a trip total. It also refuses to sum a set with mixed `priceBasis` — adding a pre-tax hotel to an all-in flight produces a number that is neither, and quoting it is exactly the "confidently wrong total" failure this project exists to avoid. `checkDates` compares **date prefixes as strings**; the naive local ISO timestamps from Kiwi must never be parsed into `Date`.

- [ ] **Step 1: Write the failing test**

```ts
// test/gate-totals-budget-dates.test.ts
import { describe, expect, it } from 'vitest'
import { checkTotals, checkBudget, checkDates } from '../src/gates/checks.js'
import { money } from '../src/money.js'
import type { RehydratedItem } from '../src/gates/types.js'
import type { SupplierItem, PriceBasis } from '../src/supplier/types.js'

function hotel(id: string, minor: bigint, quantity = 1, basis: PriceBasis = 'total'): RehydratedItem {
  const item: SupplierItem = {
    sourceId: id, supplier: 'mock', kind: 'hotel', name: id,
    price: money(minor, 'EUR'), priceBasis: basis,
    fetchedAt: new Date('2026-08-16T12:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: { kind: 'hotel', checkIn: '2026-09-12', checkOut: '2026-09-19',
              nights: 7, rating: null, coordinates: null, offerSource: null },
  }
  return { ref: { sourceId: id, quantity, slot: 'stay' }, item,
           lineTotal: money(minor * BigInt(quantity), 'EUR') }
}

function flight(id: string, dep: string, arr: string): RehydratedItem {
  const item: SupplierItem = {
    sourceId: id, supplier: 'kiwi', kind: 'flight', name: id,
    price: money(10_000n, 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-08-16T12:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'flight',
      outbound: { from: 'BER', to: 'FAO', departureLocal: dep, arrivalLocal: dep,
                  stops: 0, route: [], cabinClass: 'Economy', carriers: [] },
      inbound: { from: 'FAO', to: 'BER', departureLocal: arr, arrivalLocal: arr,
                 stops: 0, route: [], cabinClass: 'Economy', carriers: [] },
      baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
      totalDurationSeconds: 1, selfTransfer: false,
    },
  }
  return { ref: { sourceId: id, quantity: 1, slot: 'flight' }, item, lineTotal: item.price }
}

describe('checkTotals', () => {
  it('sums line totals server-side', () => {
    const r = checkTotals([hotel('A', 10_000n, 7), hotel('B', 5_000n)])
    expect(r.violations).toEqual([])
    expect(r.total!.minor).toBe(75_000n)
    expect(r.total!.currency).toBe('EUR')
  })

  it('refuses to sum mixed price bases', () => {
    const r = checkTotals([hotel('A', 10_000n, 1, 'total'), hotel('B', 5_000n, 1, 'pre_tax')])
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]!.gate).toBe('totals')
    expect(r.total).toBeNull()
    expect(r.violations[0]!.detail).toMatch(/tax/i)
  })

  it('refuses to sum mixed currencies rather than throwing', () => {
    const gbp = hotel('G', 1_000n)
    const mixed = { ...gbp, item: { ...gbp.item, price: money(1_000n, 'GBP') },
                    lineTotal: money(1_000n, 'GBP') }
    const r = checkTotals([hotel('A', 10_000n), mixed])
    expect(r.violations).toHaveLength(1)
    expect(r.total).toBeNull()
  })

  it('returns a null total and no violation for an empty set', () => {
    expect(checkTotals([])).toEqual({ violations: [], total: null })
  })

  it('recomputes rather than trusting a tampered lineTotal', () => {
    const lying = { ...hotel('L', 10_000n, 2), lineTotal: money(1n, 'EUR') }
    expect(checkTotals([lying]).total!.minor).toBe(20_000n)
  })
})

describe('checkBudget', () => {
  it('passes a total at exactly the budget', () => {
    expect(checkBudget([hotel('A', 10_000n)], money(10_000n, 'EUR'))).toEqual([])
  })

  it('fails a total one minor unit over', () => {
    const v = checkBudget([hotel('A', 10_001n)], money(10_000n, 'EUR'))
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('budget')
    expect(v[0]!.detail).toMatch(/100\.01|10001|€/)
  })

  it('passes when no budget is set', () => {
    expect(checkBudget([hotel('A', 999_999n)], null)).toEqual([])
  })

  it('fails closed when the budget currency differs from the items', () => {
    const v = checkBudget([hotel('A', 100n)], money(999_999n, 'GBP'))
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('budget')
  })

  it('does not run its own sum when totals already failed', () => {
    const mixed = checkBudget(
      [hotel('A', 10n, 1, 'total'), hotel('B', 10n, 1, 'pre_tax')],
      money(1n, 'EUR'),
    )
    // Mixed bases mean there is no trustworthy total; budget must not invent one.
    expect(mixed).toHaveLength(1)
    expect(mixed[0]!.detail).toMatch(/total/i)
  })
})

describe('checkDates', () => {
  const win = { earliest: '2026-09-10', latest: '2026-09-20' }

  it('passes flights inside the window', () => {
    expect(checkDates([flight('F', '2026-09-12T16:40:00', '2026-09-19T08:00:00')], win))
      .toEqual([])
  })

  it('fails a departure before the window', () => {
    const v = checkDates([flight('EARLY', '2026-09-09T23:59:00', '2026-09-19T08:00:00')], win)
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('dates')
    expect(v[0]!.sourceIds).toEqual(['EARLY'])
  })

  it('fails a return after the window', () => {
    expect(checkDates([flight('LATE', '2026-09-12T10:00:00', '2026-09-21T00:01:00')], win))
      .toHaveLength(1)
  })

  it('compares date prefixes, so a late local time on the last day still passes', () => {
    // 23:59 local on the final day is inside the window. Parsing this as a Date
    // in a positive-offset timezone would roll it to the next day and fail.
    expect(checkDates([flight('EDGE', '2026-09-10T00:00:00', '2026-09-20T23:59:00')], win))
      .toEqual([])
  })

  it('checks hotel check-in and check-out too', () => {
    const late = hotel('H', 1n)
    const shifted = { ...late, item: { ...late.item, detail: {
      ...late.item.detail, kind: 'hotel' as const, checkIn: '2026-09-12',
      checkOut: '2026-09-30', nights: 18, rating: null, coordinates: null, offerSource: null } } }
    expect(checkDates([shifted], win)).toHaveLength(1)
  })

  it('passes when no window is set', () => {
    expect(checkDates([flight('F', '2020-01-01T00:00:00', '2030-01-01T00:00:00')], null))
      .toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/gate-totals-budget-dates.test.ts`
Expected: FAIL — `checkTotals` is not exported.

- [ ] **Step 3: Append the implementation to `src/gates/checks.ts`**

```ts
import { money, sumMoney, compareMoney, formatMoney, type Money } from '../money.js'
import { isFlight, isHotel } from '../supplier/types.js'

export type DateWindow = { earliest: string; latest: string }

/**
 * The ONLY producer of a trip total. Recomputes from `price × quantity` rather
 * than trusting the `lineTotal` it was handed, so a caller that mutated one
 * cannot move the total.
 *
 * Mixed price bases are refused rather than summed. Adding a pre-tax hotel to
 * an all-in flight yields a number that is neither, and quoting it is precisely
 * the confidently-wrong-total failure the gate stack exists to prevent.
 */
export function checkTotals(
  items: RehydratedItem[],
): { violations: Violation[]; total: Money | null } {
  if (items.length === 0) return { violations: [], total: null }

  const bases = [...new Set(items.map((i) => i.item.priceBasis))]
  if (bases.length > 1) {
    return {
      total: null,
      violations: [{
        gate: 'totals',
        sourceIds: items.map((i) => i.item.sourceId),
        detail: `These items mix all-in and pre-tax prices (${bases.join(', ')}), so they `
              + `cannot be summed into one total. Re-search so every item quotes the same basis.`,
      }],
    }
  }

  const currencies = [...new Set(items.map((i) => i.item.price.currency))]
  if (currencies.length > 1) {
    return {
      total: null,
      violations: [{
        gate: 'totals',
        sourceIds: items.map((i) => i.item.sourceId),
        detail: `These items are priced in ${currencies.join(' and ')} and cannot be summed. `
              + `We do not convert between currencies.`,
      }],
    }
  }

  const recomputed = items.map((i) =>
    money(i.item.price.minor * BigInt(i.ref.quantity), i.item.price.currency))
  return { violations: [], total: sumMoney(recomputed) }
}

/**
 * Runs `checkTotals` itself rather than accepting a total from a caller — a
 * budget check against a number someone else computed is a budget check against
 * whatever they wanted it to be. When totals cannot produce a trustworthy sum,
 * budget reports that instead of inventing one.
 */
export function checkBudget(items: RehydratedItem[], budget: Money | null): Violation[] {
  if (!budget || items.length === 0) return []
  const { violations, total } = checkTotals(items)
  if (!total) {
    return [{
      gate: 'budget',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `Cannot check the budget because these items have no single trustworthy total: `
            + `${violations.map((v) => v.detail).join(' ')}`,
    }]
  }
  if (total.currency !== budget.currency) {
    return [{
      gate: 'budget',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `The budget is set in ${budget.currency} but this trip totals in `
            + `${total.currency}. We do not convert; search in ${budget.currency}.`,
    }]
  }
  if (compareMoney(total, budget) > 0) {
    return [{
      gate: 'budget',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `This trip totals ${formatMoney(total)}, over the ${formatMoney(budget)} budget.`,
    }]
  }
  return []
}

/**
 * Compares DATE PREFIXES as strings. Kiwi returns naive local ISO with no
 * offset ("2026-09-12T16:40:00"); `new Date()` on one of those applies the
 * server's timezone and can roll a 23:59 departure into the next day, failing a
 * window the traveller's own calendar says is fine. Lexicographic comparison of
 * `yyyy-mm-dd` is exactly date ordering, so no parsing is needed at all.
 */
export function checkDates(items: RehydratedItem[], window: DateWindow | null): Violation[] {
  if (!window) return []
  const offenders: string[] = []
  for (const { item } of items) {
    const dates: string[] = []
    if (isFlight(item)) {
      dates.push(day(item.detail.outbound.departureLocal))
      if (item.detail.inbound) dates.push(day(item.detail.inbound.departureLocal))
    } else if (isHotel(item)) {
      dates.push(day(item.detail.checkIn), day(item.detail.checkOut))
    }
    if (dates.some((d) => d < window.earliest || d > window.latest)) {
      offenders.push(item.sourceId)
    }
  }
  if (offenders.length === 0) return []
  return [{
    gate: 'dates',
    sourceIds: offenders,
    detail: `These items fall outside the ${window.earliest} to ${window.latest} travel window: `
          + `${offenders.join(', ')}.`,
  }]
}

/** First 10 chars of an ISO timestamp — the date, with no parsing and no zone. */
function day(iso: string): string {
  return iso.slice(0, 10)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/gate-totals-budget-dates.test.ts && npx tsc --noEmit`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gates/checks.ts test/gate-totals-budget-dates.test.ts
git commit -m "feat: add totals, budget, and dates gates with string date comparison"
```

---

### Task 11: The gate pipeline and gate_results persistence

**Files:**
- Create: `src/gates/pipeline.ts`
- Create: `src/repo/gateResults.ts`
- Test: `test/gate-pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 8–10.
- Produces:
  - `recordGateResults(sql, args): Promise<void>`
  - `runGates(sql, args: {conversationId, turnId, refs, notebook, now}): Promise<GateOutcome>`
  - `type NotebookConstraints = {budget: Money | null; window: DateWindow | null; currency: string}`

**Context:** The pipeline composes the gates in the spec's order and **writes a `gate_results` row for every gate it ran, pass or fail**. Two ordering rules matter and must be tested: provenance runs first and short-circuits (there is nothing to check the freshness of if the item does not exist), and the remaining deterministic gates all run so the model gets every problem in one reply rather than one per round trip.

The reviewer seat (`gate: 'reviewer'`) is **not** implemented here — it needs a model and lands in plan 3. The enum already carries the value and the pipeline leaves the seam.

- [ ] **Step 1: Write the failing test**

```ts
// test/gate-pipeline.test.ts
import { expect, it, describe } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults } from '../src/repo/toolResults.js'
import { runGates } from '../src/gates/pipeline.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-08-16T12:00:00Z')
const notebook = {
  budget: money(10_000_00n, 'EUR'),
  window: { earliest: '2026-09-01', latest: '2026-09-30' },
  currency: 'EUR',
}

async function seed(sql: any, n: string, at = NOW) {
  const userId = `00000000-0000-4000-8000-0000000003${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const conversationId = c!.id as string
  const items = await new MockSupplier({ kind: 'flight', now: () => at }).search(params)
  await recordResults(sql, { conversationId, userId, turnId: null, params, items })
  return { userId, conversationId, items }
}

describeDb('runGates', () => {
  it('passes a clean proposal and returns a server-computed total', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '01')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      expect(res.total.minor).toBe(items[0]!.price.minor)
    })
  })

  it('writes a gate_results row for every gate it ran, including passes', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '02')
      await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      const rows = await sql<{ gate: string; passed: boolean }[]>`
        select gate, passed from gate_results where conversation_id = ${conversationId}`
      const gates = rows.map((r) => r.gate).sort()
      expect(gates).toEqual(['budget', 'currency', 'dates', 'freshness', 'provenance', 'totals'])
      expect(rows.every((r) => r.passed)).toBe(true)
    })
  })

  it('short-circuits on provenance and does not run the later gates', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seed(sql, '03')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: 'GHOST', quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      const rows = await sql<{ gate: string; passed: boolean }[]>`
        select gate, passed from gate_results where conversation_id = ${conversationId}`
      expect(rows.map((r) => r.gate)).toEqual(['provenance'])
      expect(rows[0]!.passed).toBe(false)
    })
  })

  it('reports every deterministic violation in one pass, not one per round trip', async () => {
    await withTestDb(async (sql) => {
      // Seeded well in the past: freshness fails. Budget of 1 cent: budget fails too.
      const old = new Date('2026-08-01T12:00:00Z')
      const { conversationId, items } = await seed(sql, '04', old)
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW,
        notebook: { ...notebook, budget: money(1n, 'EUR') },
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'flight' }],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      const gates = res.violations.map((v) => v.gate).sort()
      expect(gates).toContain('freshness')
      expect(gates).toContain('budget')
      expect(gates.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('rejects a tampered payload at the schema before touching the database', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '05')
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'f', price: 1 } as any],
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.violations[0]!.gate).toBe('provenance')
      expect(res.violations[0]!.detail).toMatch(/price|unrecognis|unrecogniz|reference/i)
    })
  })

  it('never lets a model-supplied price reach the total', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, items } = await seed(sql, '06')
      const real = items[0]!.price.minor
      const res = await runGates(sql, {
        conversationId, turnId: null, now: NOW, notebook,
        refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'f' }],
      })
      if (!res.ok) throw new Error('expected pass')
      expect(res.total.minor).toBe(real)
      expect(res.items[0]!.item.price.minor).toBe(real)
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/gate-pipeline.test.ts`
Expected: FAIL — cannot resolve `../src/gates/pipeline.js`.

- [ ] **Step 3: Write `src/repo/gateResults.ts`**

```ts
import type postgres from 'postgres'
import type { GateName } from '../gates/types.js'

export type GateResultRow = {
  gate: GateName | 'reviewer'
  passed: boolean
  detail: string | null
  sourceIds: string[]
}

/**
 * Writes every gate outcome — passes as well as failures. A table holding only
 * failures cannot answer "how often did freshness fire?", which is the first
 * question slice 2 asks of this data.
 *
 * One multi-row insert rather than a loop: the pipeline writes up to six rows
 * per proposal and a per-row round trip is six network hops inside a turn that
 * is already being timed against a heartbeat.
 */
export async function recordGateResults(
  sql: postgres.Sql,
  args: {
    conversationId: string
    turnId: string | null
    proposalId: string | null
    round: number
    results: GateResultRow[]
  },
): Promise<void> {
  if (args.results.length === 0) return
  const rows = args.results.map((r) => ({
    conversation_id: args.conversationId,
    turn_id: args.turnId,
    proposal_id: args.proposalId,
    round: args.round,
    gate: r.gate,
    passed: r.passed,
    detail: r.detail,
    source_ids: r.sourceIds,
  }))
  await sql`insert into gate_results ${sql(rows)}`
}
```

- [ ] **Step 4: Write `src/gates/pipeline.ts`**

```ts
import type postgres from 'postgres'
import type { Money } from '../money.js'
import { ProposalRefsSchema, rehydrateRefs } from './rehydrateGate.js'
import { checkFreshness, checkCurrency, checkTotals, checkBudget, checkDates,
         type DateWindow } from './checks.js'
import { recordGateResults, type GateResultRow } from '../repo/gateResults.js'
import type { GateOutcome, ItemRef, Violation } from './types.js'

export type NotebookConstraints = {
  budget: Money | null
  window: DateWindow | null
  currency: string
}

/**
 * The back-office gate, in the spec's order.
 *
 * Provenance runs FIRST and short-circuits: there is nothing to check the
 * freshness, currency, or dates of if the item does not exist. Everything after
 * it runs to completion even once one has failed, so the model gets every
 * problem in a single reply — one violation per round trip would turn a
 * three-fault proposal into three model calls.
 *
 * The reviewer seat is deliberately absent: it needs a model and arrives in
 * plan 3. `gate_results.gate` already accepts 'reviewer'.
 */
export async function runGates(
  sql: postgres.Sql,
  args: {
    conversationId: string
    turnId: string | null
    refs: unknown
    notebook: NotebookConstraints
    now: Date
    proposalId?: string | null
    round?: number
  },
): Promise<GateOutcome> {
  const round = args.round ?? 0
  const proposalId = args.proposalId ?? null
  const write = (results: GateResultRow[]) =>
    recordGateResults(sql, {
      conversationId: args.conversationId, turnId: args.turnId, proposalId, round, results,
    })

  // The schema is the first gate. A payload carrying a price never reaches the
  // database at all — there is no value here to validate, only references.
  const parsed = ProposalRefsSchema.safeParse(args.refs)
  if (!parsed.success) {
    const detail = `The proposal must reference search results and nothing else `
                 + `({sourceId, quantity, slot}). Rejected: `
                 + parsed.error.issues.map((i) => i.message).join('; ')
    const violations: Violation[] = [{ gate: 'provenance', sourceIds: [], detail }]
    await write([{ gate: 'provenance', passed: false, detail, sourceIds: [] }])
    return { ok: false, violations }
  }
  const refs: ItemRef[] = parsed.data.refs

  const hydrated = await rehydrateRefs(sql, args.conversationId, refs)
  if (!hydrated.ok) {
    await write(hydrated.violations.map((v) => ({
      gate: v.gate, passed: false, detail: v.detail, sourceIds: v.sourceIds,
    })))
    return { ok: false, violations: hydrated.violations }
  }
  const items = hydrated.items

  const freshness = checkFreshness(items, args.now)
  const currency = checkCurrency(items, args.notebook.currency)
  const { violations: totalsV, total } = checkTotals(items)
  const budget = checkBudget(items, args.notebook.budget)
  const dates = checkDates(items, args.notebook.window)

  const all = [...freshness, ...currency, ...totalsV, ...budget, ...dates]
  const results: GateResultRow[] = [
    { gate: 'provenance', passed: true, detail: null,
      sourceIds: items.map((i) => i.item.sourceId) },
    row('freshness', freshness), row('currency', currency), row('totals', totalsV),
    row('budget', budget), row('dates', dates),
  ]
  await write(results)

  if (all.length > 0) return { ok: false, violations: all }
  // total is non-null here: checkTotals only returns null on an empty set (the
  // schema requires >= 1 ref) or a violation (which we just returned on).
  return { ok: true, items, total: total! }
}

function row(gate: GateResultRow['gate'], violations: Violation[]): GateResultRow {
  return violations.length === 0
    ? { gate, passed: true, detail: null, sourceIds: [] }
    : { gate, passed: false, detail: violations[0]!.detail, sourceIds: violations[0]!.sourceIds }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/gate-pipeline.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/gates/pipeline.ts src/repo/gateResults.ts test/gate-pipeline.test.ts
git commit -m "feat: compose the gate pipeline and persist every gate outcome"
```

---

### Task 12: The global daily ceiling

**Files:**
- Modify: `src/repo/spend.ts`
- Modify: `src/engine.ts`
- Modify: `src/handler.ts`
- Test: `test/spend.test.ts` (extend)
- Test: `test/engine.test.ts` (extend)

**Interfaces:**
- Consumes: `Limits` (already carries `globalCeilingMicros`), `readSpendFailClosed`.
- Produces: `readSpendFailClosed` returns an added `globalMicros: bigint`; `decideNext` honours it.

**Context:** `DEFAULT_LIMITS.globalCeilingMicros` exists and is enforced by nothing — spec §8 calls the global ceiling "the cap that actually matters" at one user, because it is what stops a runaway loop at 3am. This task connects it.

**Precedence, which must be pinned by test:** global → conversation → daily → step cap → deadline. Global comes first because it is the only ceiling protecting the account rather than the user; a runaway that has exhausted the account must not be reported as a per-conversation problem.

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/spend.test.ts
it('reads the global daily total across all users', async () => {
  await withTestDb(async (sql) => {
    const a = '00000000-0000-4000-8000-00000000aa01'
    const b = '00000000-0000-4000-8000-00000000bb01'
    const [ca] = await sql`insert into conversations (user_id) values (${a}) returning id`
    const [cb] = await sql`insert into conversations (user_id) values (${b}) returning id`
    await recordSpend(sql, { userId: a, conversationId: ca!.id, costMicros: 1_000n })
    await recordSpend(sql, { userId: b, conversationId: cb!.id, costMicros: 2_500n })

    const spend = await readSpendFailClosed(sql, a, ca!.id)
    expect(spend.dailyMicros).toBe(1_000n)          // this user only
    expect(spend.globalMicros).toBeGreaterThanOrEqual(3_500n)  // every user today
  })
})

it('fails closed on the global read too', async () => {
  await withTestDb(async (sql) => {
    await expect(readSpendFailClosed(
      sql, '00000000-0000-4000-8000-00000000cc01',
      '00000000-0000-4000-8000-00000000cc02',
    )).rejects.toThrow(/fail closed/i)
  })
})
```

```ts
// append to test/engine.test.ts
describe('global ceiling', () => {
  const limits = {
    conversationCeilingMicros: 8_000_000n,
    dailyCeilingMicros: 15_000_000n,
    globalCeilingMicros: 50_000_000n,
    maxSteps: 24,
  }
  const base = {
    state: { step: 0, messages: [], reviewRounds: 0 },
    limits, nowMs: 0, deadlineMs: 600_000, estStepMs: 60_000,
    pendingUserMessage: null,
  }

  it('stops when the global ceiling is reached', () => {
    const d = decideNext({
      ...base,
      spend: { conversationMicros: 0n, dailyMicros: 0n, globalMicros: 50_000_000n },
    })
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('takes precedence over the conversation ceiling', () => {
    // BOTH are exceeded. Global must be the one reported — pinning the order,
    // not merely that something stopped.
    const d = decideNext({
      ...base,
      spend: {
        conversationMicros: 9_000_000n, dailyMicros: 0n, globalMicros: 60_000_000n,
      },
    })
    expect(d.kind).toBe('stop')
    // Distinguishable via the engine's exported reason detail.
    expect(stopDetail(d)).toBe('global')
  })

  it('allows a call below every ceiling', () => {
    expect(decideNext({
      ...base,
      spend: { conversationMicros: 1n, dailyMicros: 1n, globalMicros: 1n },
    }).kind).toBe('call_model')
  })
})
```

**Note for the implementer:** `stopDetail` does not exist yet. Add a `detail?: 'global' | 'conversation' | 'daily'` field to the `stop` decision (or an exported helper) so the precedence test can distinguish *which* ceiling fired. A test that only asserts `kind === 'stop'` would pass with the precedence reversed, which is exactly the class of defect plan 1 kept producing.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/spend.test.ts test/engine.test.ts`
Expected: FAIL — `globalMicros` is not returned; `stopDetail` is not exported.

- [ ] **Step 3: Implement**

In `src/repo/spend.ts`, extend `readSpendFailClosed` to also read:

```ts
const global = await sql`
  select coalesce(sum(cost_micros), 0)::text as total
    from daily_usage where day = current_date`
// A sum over zero rows is 0 and that is legitimate (nobody has spent today).
// The conversation read above is what fails closed; this cannot distinguish
// "no spend" from "no answer", so it must never be the only guard.
```

Return `{ conversationMicros, dailyMicros, globalMicros }`.

In `src/engine.ts`, add `globalMicros` to the `Spend` type and check it **first** in `decideNext`, before the conversation ceiling. Add the `detail` discriminator to the `stop` decision.

In `src/handler.ts`, add the global ceiling to the pre-turn check alongside the existing two, so a capped account is refused at tier 2 rather than one step into a turn.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS — every earlier test still green (the `Spend` type change touches `worker.ts` and `handler.ts` call sites).

- [ ] **Step 5: Commit**

```bash
git add src/repo/spend.ts src/engine.ts src/handler.ts test/spend.test.ts test/engine.test.ts
git commit -m "feat: enforce the global daily ceiling with pinned precedence"
```

---

## Self-review

**Spec coverage.** §4's `explore_flights`/`explore_hotels` are served by Tasks 5 and 7 behind the port from Task 2. §5's rehydration, freshness, currency, totals, budget, and dates gates are Tasks 8–11; `propose_itinerary`'s reviewer round and `hand_off_to_booking` are explicitly **deferred to plan 3**, because both need a model. §6's `tool_results`, `proposals`, `gate_results`, `link_clicks`, and `conversions` are Task 1. §8's global daily ceiling is Task 12. §11's named gate tests all appear: tampered price (Task 8), source past TTL (Task 9), two currencies refused (Task 9), re-quote that throws blocks (Task 3's `quoteMode`, consumed by the cashier in plan 3).

**Known gaps, deliberate.** The cashier, the reviewer seat, `revise_component`, and the host allowlist for `bookingUrl` are plan 3. The `proposals` table is created here but only written in plan 3 — Task 11 accepts a `proposalId` and passes it through, so the seam exists rather than needing retrofitting.

**Type consistency.** `SupplierItem`, `ItemRef`, `RehydratedItem`, and `Violation` are declared once in the interfaces block and referenced by every consuming task. `nightsBetween` is exported from `mock.ts` and reused by `searchapi.ts` rather than reimplemented. `checkTotals` returns `{violations, total}` in Tasks 10 and 11 alike. `readSpendFailClosed`'s return type gains one field in Task 12 and every existing caller is named in that task's step 4.

**Carried forward from plan 1.** Article defects found during implementation are reported in the implementer's report and annotated into `docs/part-*.md` as `REVIEW(globetrotty)` HTML comments by the controller — a standing instruction from the project owner, not a per-task step.
