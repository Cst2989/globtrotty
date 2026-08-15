# Globetrotty Harness Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable turn-execution harness on Netlify + Supabase that survives crashes, retries, and concurrent workers — proven end-to-end with a trivial echo agent, before any real model or supplier is wired in.

**Architecture:** Four tiers (browser → sync route handler → background function → scheduled sweeper) over Postgres. All decision logic is pure functions with no I/O; the shell owns the database, the clock, and the model provider and hands them in. Turn ownership is a single-statement claim with a fencing token; every post-claim write is guarded by that token so a slow-but-alive worker cannot clobber its successor.

**Tech Stack:** TypeScript, Next.js 15 (App Router), Netlify Functions, Supabase Postgres, `postgres` (porsager) for the worker, vitest, zod, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-15-globetrotty-design.md`

## Plan sequence

This is plan 1 of 4 for slice 1. Each produces working, testable software on its own:

1. **Harness foundation** (this plan) — schema, engine/shell, claim, sweeper, spend ledger, traces, four tiers, echo agent
2. **Supplier port and gates** — `Supplier` interface, `MockSupplier`, Kiwi MCP adapter, `tool_results` corpus, rehydration/freshness/currency/totals/budget/dates
3. **The fleet** — front desk, planning desk loop, scouts, reviewer, cashier, prompts
4. **Chat UI** — split channel, proposal cards, per-component actions, sidebar

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include these.

- **Money is never a bare number.** Every amount is `{ minor: bigint, currency: string }`. Traveller money uses ISO-4217 minor units with the exponent derived from the code, never assumed to be 2. Model spend is `usd_micros bigint`. Comparing or summing two different currencies is a **violation**, never a conversion.
- **Fail closed.** Any limit protecting money denies the request when it cannot confirm current usage. `count ?? 0` is a banned pattern; a lint rule enforces it.
- **Persist state, then schedule the next work.** Never the reverse.
- **The worker connects as an RLS-subject role** with the request identity set per transaction. The service role is used by exactly two modules: the sweeper and the retention job.
- **Every post-claim write carries the fencing token** (`and attempts = $claimed`). `rowCount === 0` means fenced: abort immediately, write nothing else.
- **`recordSpan` is best-effort and swallowed. `recordSpend` is not** — if it cannot be written, the turn stops.
- **Parking is a terminal turn status** (`turns.status = 'done'`, `conversations.status = 'awaiting_user'`).
- Node 22+, pnpm, TypeScript strict mode, `"type": "module"`.

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore` (exists — extend), `src/env.ts`
- Test: `test/env.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadEnv(source: Record<string,string|undefined>): Env` where `Env = { DATABASE_URL: string; SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string; WORKER_SHARED_SECRET: string; ANTHROPIC_API_KEY: string; SITE_URL: string }`. Throws `EnvError` listing every missing key at once.

- [ ] **Step 1: Initialise the project**

```bash
pnpm init
pnpm add -D typescript vitest @types/node tsx
pnpm add zod postgres
```

Set `"type": "module"` in `package.json` and add scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test", "netlify"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
})
```

- [ ] **Step 2: Write the failing test**

`test/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadEnv, EnvError } from '../src/env.js'

const complete = {
  DATABASE_URL: 'postgres://localhost/globetrotty',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  WORKER_SHARED_SECRET: 'shh',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SITE_URL: 'http://localhost:8888',
}

describe('loadEnv', () => {
  it('returns a typed env when everything is present', () => {
    expect(loadEnv(complete).DATABASE_URL).toBe('postgres://localhost/globetrotty')
  })

  it('reports every missing key at once, not just the first', () => {
    const { DATABASE_URL, SITE_URL, ...rest } = complete
    try {
      loadEnv(rest)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError)
      expect((e as EnvError).missing.sort()).toEqual(['DATABASE_URL', 'SITE_URL'])
    }
  })

  it('treats an empty string as missing', () => {
    expect(() => loadEnv({ ...complete, WORKER_SHARED_SECRET: '' })).toThrow(EnvError)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm test env`
Expected: FAIL — `Cannot find module '../src/env.js'`

- [ ] **Step 4: Implement**

`src/env.ts`:

```ts
const KEYS = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WORKER_SHARED_SECRET',
  'ANTHROPIC_API_KEY',
  'SITE_URL',
] as const

export type Env = Record<(typeof KEYS)[number], string>

export class EnvError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required environment variables: ${missing.join(', ')}`)
    this.name = 'EnvError'
  }
}

export function loadEnv(source: Record<string, string | undefined>): Env {
  const missing = KEYS.filter((k) => !source[k])
  if (missing.length) throw new EnvError([...missing])
  return Object.fromEntries(KEYS.map((k) => [k, source[k]!])) as Env
}
```

`.env.example` listing all seven keys with empty values and a comment on each.

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: 3 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/env.ts test/env.test.ts
git commit -m "feat: project scaffold with fail-fast env loading"
```

---

### Task 2: Money and currency primitives

**Files:**
- Create: `src/money.ts`
- Test: `test/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Money = { minor: bigint; currency: string }`
  - `money(minor: bigint | number, currency: string): Money` — validates ISO-4217 shape, throws on unknown code
  - `addMoney(a: Money, b: Money): Money` — throws `CurrencyMismatchError` on differing currencies
  - `sumMoney(items: Money[]): Money` — throws on empty array or mixed currencies
  - `compareMoney(a: Money, b: Money): -1 | 0 | 1` — throws on mismatch
  - `formatMoney(m: Money): string` — e.g. `"€1,412.00"`, `"¥1412"` (JPY exponent 0)
  - `minorUnitExponent(currency: string): number`
  - `class CurrencyMismatchError extends Error { a: string; b: string }`

This is the highest-leverage pure module in the system: it is what makes "the cashier compared two bare integers" impossible to write.

- [ ] **Step 1: Write the failing test**

`test/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  money, addMoney, sumMoney, compareMoney, formatMoney,
  minorUnitExponent, CurrencyMismatchError,
} from '../src/money.js'

describe('minorUnitExponent', () => {
  it('is 2 for the common case', () => expect(minorUnitExponent('EUR')).toBe(2))
  it('is 0 for JPY', () => expect(minorUnitExponent('JPY')).toBe(0))
  it('is 3 for KWD', () => expect(minorUnitExponent('KWD')).toBe(3))
  it('rejects an unknown code', () => expect(() => minorUnitExponent('XYZ')).toThrow())
})

describe('money', () => {
  it('normalises a number to bigint', () => {
    expect(money(1412_00, 'EUR')).toEqual({ minor: 141200n, currency: 'EUR' })
  })
  it('rejects a non-integer amount', () => expect(() => money(10.5 as never, 'EUR')).toThrow())
  it('uppercases the currency', () => expect(money(1n, 'eur').currency).toBe('EUR'))
})

describe('currency safety', () => {
  it('refuses to add different currencies', () => {
    expect(() => addMoney(money(100n, 'EUR'), money(100n, 'GBP')))
      .toThrow(CurrencyMismatchError)
  })
  it('refuses to compare different currencies — the cashier bug', () => {
    // 1400 GBP is numerically less than 1500 EUR but costs more.
    expect(() => compareMoney(money(140000n, 'GBP'), money(150000n, 'EUR')))
      .toThrow(CurrencyMismatchError)
  })
  it('refuses to sum a mixed list', () => {
    expect(() => sumMoney([money(1n, 'EUR'), money(1n, 'USD')])).toThrow(CurrencyMismatchError)
  })
  it('refuses to sum an empty list, because the currency would be unknowable', () => {
    expect(() => sumMoney([])).toThrow()
  })
})

describe('arithmetic', () => {
  it('sums same-currency amounts', () => {
    expect(sumMoney([money(60000n, 'EUR'), money(80000n, 'EUR')]))
      .toEqual({ minor: 140000n, currency: 'EUR' })
  })
  it('does not overflow on large minor units', () => {
    const big = money(9_000_000_000n, 'IDR')     // > 2^31
    expect(addMoney(big, big).minor).toBe(18_000_000_000n)
  })
  it('compares correctly', () => {
    expect(compareMoney(money(100n, 'EUR'), money(200n, 'EUR'))).toBe(-1)
    expect(compareMoney(money(200n, 'EUR'), money(200n, 'EUR'))).toBe(0)
  })
})

describe('formatMoney', () => {
  it('renders 2-exponent currencies', () => expect(formatMoney(money(141200n, 'EUR'))).toContain('1,412'))
  it('renders 0-exponent currencies without decimals', () => {
    expect(formatMoney(money(1412n, 'JPY'))).not.toContain('.')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test money`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/money.ts`:

```ts
// ISO-4217 minor-unit exponents. Only non-2 values need listing.
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

// Currencies we accept. Extend deliberately; an unknown code must throw
// rather than silently default, because a wrong exponent is a 100x error.
const KNOWN = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'RON',
  'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'KWD', 'BHD', 'TND',
  'CAD', 'AUD', 'NZD', 'BRL', 'MXN', 'ZAR', 'TRY', 'AED',
])

export type Money = { minor: bigint; currency: string }

export class CurrencyMismatchError extends Error {
  constructor(readonly a: string, readonly b: string) {
    super(`Refusing to combine ${a} with ${b}. Convert deliberately or reject; never coerce.`)
    this.name = 'CurrencyMismatchError'
  }
}

export function minorUnitExponent(currency: string): number {
  const c = currency.toUpperCase()
  if (!KNOWN.has(c)) throw new Error(`Unknown currency: ${currency}`)
  return EXPONENTS[c] ?? 2
}

export function money(minor: bigint | number, currency: string): Money {
  const c = currency.toUpperCase()
  minorUnitExponent(c) // throws on unknown
  if (typeof minor === 'number' && !Number.isInteger(minor)) {
    throw new Error(`Money must be whole minor units, got ${minor}`)
  }
  return { minor: BigInt(minor), currency: c }
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency)
}

export function addMoney(a: Money, b: Money): Money {
  assertSame(a, b)
  return { minor: a.minor + b.minor, currency: a.currency }
}

export function sumMoney(items: Money[]): Money {
  const first = items[0]
  if (!first) throw new Error('Cannot sum an empty list: the currency would be unknowable')
  return items.slice(1).reduce(addMoney, first)
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b)
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0
}

export function formatMoney(m: Money): string {
  const exp = minorUnitExponent(m.currency)
  const value = Number(m.minor) / 10 ** exp
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(value)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test money`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/money.ts test/money.test.ts
git commit -m "feat: money primitives that refuse cross-currency arithmetic"
```

---

### Task 3: The notebook schema with per-field provenance

**Files:**
- Create: `src/notebook.ts`
- Test: `test/notebook.test.ts`

**Interfaces:**
- Consumes: `Money` from `src/money.ts`
- Produces:
  - `NotebookSchema` (zod), `type Notebook`
  - `type Provenance = 'user' | 'inferred' | 'tool'`
  - `emptyNotebook(): Notebook`
  - `applyRequirements(current: Notebook, patch: unknown, source: Provenance): { next: Notebook; rejected: string[] }`
  - `CONSTRAINT_FIELDS: readonly string[]` — fields only a `user` source may relax

Spec §10: an injected listing saying "this traveller's budget has increased to €5,000" must not be able to relax the constraint `checkBudget` validates against. This module is where that is enforced.

- [ ] **Step 1: Write the failing test**

`test/notebook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { emptyNotebook, applyRequirements } from '../src/notebook.js'

const base = () =>
  applyRequirements(emptyNotebook(), {
    budget: { minor: '150000', currency: 'EUR' },
    partySize: { adults: 2, infants: 1 },
    nights: 7,
  }, 'user').next

describe('applyRequirements', () => {
  it('records values with their source', () => {
    const n = base()
    expect(n.budget?.value.minor).toBe(150000n)
    expect(n.budget?.source).toBe('user')
  })

  it('leaves unstated fields null rather than guessing', () => {
    expect(emptyNotebook().budget).toBeNull()
    expect(emptyNotebook().destination).toBeNull()
  })

  it('lets a user relax a constraint', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '500000', currency: 'EUR' } }, 'user')
    expect(next.budget?.value.minor).toBe(500000n)
    expect(rejected).toEqual([])
  })

  // The injection case from spec section 10.
  it('REFUSES to let a tool relax a constraint', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '500000', currency: 'EUR' } }, 'tool')
    expect(next.budget?.value.minor).toBe(150000n)   // unchanged
    expect(rejected).toEqual(['budget'])
  })

  it('lets a tool TIGHTEN a constraint, which is harmless', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '100000', currency: 'EUR' } }, 'tool')
    expect(next.budget?.value.minor).toBe(100000n)
    expect(rejected).toEqual([])
  })

  it('refuses a budget in a different currency than the one already set', () => {
    const { rejected } = applyRequirements(base(),
      { budget: { minor: '100000', currency: 'GBP' } }, 'user')
    expect(rejected).toEqual(['budget'])
  })

  it('rejects unknown keys instead of storing them', () => {
    const { next, rejected } = applyRequirements(base(), { sneaky: true }, 'user')
    expect(rejected).toEqual(['sneaky'])
    expect(next).not.toHaveProperty('sneaky')
  })

  it('marks inferred facts as inferred', () => {
    const { next } = applyRequirements(base(), { nearBeach: true }, 'inferred')
    expect(next.nearBeach?.source).toBe('inferred')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test notebook`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/notebook.ts`:

```ts
import { z } from 'zod'
import { money, type Money, compareMoney } from './money.js'

export type Provenance = 'user' | 'inferred' | 'tool'

export type Field<T> = { value: T; source: Provenance; at: string } | null

export type Notebook = {
  budget: Field<Money>
  destination: Field<string>
  originCity: Field<string>
  departureDate: Field<string>      // ISO 8601
  returnDate: Field<string>
  nights: Field<number>
  partySize: Field<{ adults: number; children: number; infants: number }>
  nearBeach: Field<boolean>
  needsCrib: Field<boolean>
  maxStops: Field<number>
  notes: Field<string>
}

// Fields where a looser value costs the traveller money or safety.
// Only a `user` source may relax these.
export const CONSTRAINT_FIELDS = ['budget', 'maxStops', 'nights'] as const

const MoneyIn = z.object({ minor: z.union([z.string(), z.number()]), currency: z.string() })

const PatchSchema = z.object({
  budget: MoneyIn.optional(),
  destination: z.string().min(1).optional(),
  originCity: z.string().min(1).optional(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nights: z.number().int().min(1).max(60).optional(),
  partySize: z.object({
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(9).default(0),
    infants: z.number().int().min(0).max(9).default(0),
  }).optional(),
  nearBeach: z.boolean().optional(),
  needsCrib: z.boolean().optional(),
  maxStops: z.number().int().min(0).max(3).optional(),
  notes: z.string().max(2000).optional(),
}).strict()

export function emptyNotebook(): Notebook {
  return {
    budget: null, destination: null, originCity: null, departureDate: null,
    returnDate: null, nights: null, partySize: null, nearBeach: null,
    needsCrib: null, maxStops: null, notes: null,
  }
}

/** Returns a looser-than check: true when `next` gives the traveller less protection. */
function relaxes(key: string, current: unknown, next: unknown): boolean {
  if (current == null) return false
  if (key === 'budget') {
    return compareMoney((next as Money), (current as Money)) > 0
  }
  if (key === 'maxStops' || key === 'nights') {
    return (next as number) > (current as number)
  }
  return false
}

export function applyRequirements(
  current: Notebook,
  patch: unknown,
  source: Provenance,
): { next: Notebook; rejected: string[] } {
  const parsed = PatchSchema.safeParse(patch)
  const rejected: string[] = []
  if (!parsed.success) {
    // Unknown or malformed keys are reported, never stored.
    for (const issue of parsed.error.issues) rejected.push(String(issue.path[0] ?? 'unknown'))
    const known = PatchSchema.partial().safeParse(patch)
    if (!known.success) return { next: current, rejected: [...new Set(rejected)] }
  }

  const data = (parsed.success ? parsed.data : {}) as Record<string, unknown>
  const next: Notebook = { ...current }
  const at = new Date().toISOString()

  for (const [key, raw] of Object.entries(data)) {
    if (raw === undefined) continue

    let value: unknown = raw
    if (key === 'budget') {
      const m = raw as z.infer<typeof MoneyIn>
      const parsedMoney = money(BigInt(m.minor), m.currency)
      const existing = (current.budget?.value ?? null)
      if (existing && existing.currency !== parsedMoney.currency) {
        rejected.push(key)          // never coerce currencies
        continue
      }
      value = parsedMoney
    }

    if ((CONSTRAINT_FIELDS as readonly string[]).includes(key) && source !== 'user') {
      if (relaxes(key, (current as never)[key]?.value, value)) {
        rejected.push(key)          // the injection defence
        continue
      }
    }

    ;(next as never as Record<string, unknown>)[key] = { value, source, at }
  }

  return { next, rejected: [...new Set(rejected)] }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test notebook`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/notebook.ts test/notebook.test.ts
git commit -m "feat: notebook with per-field provenance; tools cannot relax constraints"
```

---

### Task 4: Database schema

**Files:**
- Create: `supabase/migrations/0001_harness.sql`
- Create: `test/helpers/db.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: the tables in spec §6, plus `withTestDb(fn)` returning a `postgres` client bound to a per-test transaction that rolls back.

Requires a local Postgres. Use `supabase start` if the Supabase CLI is installed, or any Postgres 15+ with `DATABASE_URL` pointed at it. Tests that need a database skip cleanly when `DATABASE_URL` is unset.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0001_harness.sql` — the tables slice 1 needs. Later plans add `tool_results`, `proposals`, `gate_results`, `link_clicks`, `conversions`.

```sql
create extension if not exists pgcrypto;

create table conversations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  title         text,
  desk          text not null default 'planning'
                  check (desk in ('front','planning')),
  status        text not null default 'active'
                  check (status in ('active','working','awaiting_user','limit_reached',
                                    'escalated','failed','archived')),
  requirements  jsonb not null default '{}'::jsonb,
  spend_usd_micros bigint not null default 0 check (spend_usd_micros >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, user_id)                     -- lets children carry a composite FK
);
create index conversations_user_updated on conversations (user_id, updated_at desc);

create table turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  status          text not null default 'queued'
                    check (status in ('queued','running','done','failed')),
  state           jsonb,
  attempts        int  not null default 0 check (attempts >= 0),
  idempotency_key text not null,
  queued_at       timestamptz not null default now(),
  started_at      timestamptz,
  heartbeat_at    timestamptz,
  finished_at     timestamptz,
  spend_usd_micros bigint not null default 0 check (spend_usd_micros >= 0),
  fail_reason     text check (fail_reason in ('provider_down','fetch_failed','limit_reached',
                                              'step_cap','deadline_exceeded','crash_loop',
                                              'fenced','stalled')),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade,
  unique (conversation_id, idempotency_key)
);

-- One active turn per conversation. This is the "she pressed the button 50 times" guard.
create unique index turns_one_active_per_conversation
  on turns (conversation_id) where status in ('queued','running');

-- The sweeper's only index. Partial, so it stays small as `done` rows accumulate.
create index turns_sweeper on turns (coalesce(heartbeat_at, queued_at))
  where status in ('queued','running');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete set null,
  role            text not null check (role in ('user','agent')),
  content         text not null,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade
);
create index messages_thread on messages (conversation_id, created_at);

create table agent_events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete cascade,
  kind            text not null
                    check (kind in ('tool_start','tool_done','thinking','parked',
                                    'failed','continued')),
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade
);
create index agent_events_feed on agent_events (conversation_id, created_at);

create table tool_calls (
  turn_id    uuid not null references turns(id) on delete cascade,
  call_id    text not null,
  name       text not null,
  status     text not null check (status in ('pending','done')),
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (turn_id, call_id)
);

create table model_calls (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid,
  turn_id           uuid,
  user_id           uuid not null,
  seat              text not null
                      check (seat in ('front_desk','driver','scout','reviewer',
                                      'monitor','titler','sim_user')),
  prompt_version    text not null,
  model_config_id   text not null,
  effort            text,
  thinking_mode     text,
  max_tokens        int,
  model             text not null,          -- resolved, from response.model
  request_id        text,
  system_prompt     text,                   -- nullable: capture_policy carries the meaning
  user_prompt       text,
  response          jsonb,
  input_tokens              int not null default 0,
  cache_creation_input_tokens int not null default 0,
  cache_read_input_tokens     int not null default 0,
  output_tokens             int not null default 0,
  cost_micros       bigint not null default 0 check (cost_micros >= 0),
  latency_ms        int,
  capture_policy    text not null check (capture_policy in ('full','truncated','sampled_out')),
  created_at        timestamptz not null default now()
);
create index model_calls_retention on model_calls (created_at);
create index model_calls_cost on model_calls (conversation_id, seat);

create table daily_usage (
  user_id    uuid not null,
  day        date not null,
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table user_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  fact       text not null,
  inferred   boolean not null,
  source_turn uuid,
  created_at timestamptz not null default now()
);
create index user_memory_by_user on user_memory (user_id, created_at desc);

create table source_memory (
  id         uuid primary key default gen_random_uuid(),
  source_key text not null,
  fact       text not null,
  created_at timestamptz not null default now()
);
create index source_memory_by_key on source_memory (source_key);
```

- [ ] **Step 2: Write the failing test**

`test/helpers/db.ts`:

```ts
import postgres from 'postgres'

export const DB_URL = process.env.DATABASE_URL
export const describeDb = DB_URL ? describe : describe.skip

/** Runs fn inside a transaction that is always rolled back. */
export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL!, { max: 1, onnotice: () => {} })
  try {
    let out!: T
    await sql
      .begin(async (tx) => {
        out = await fn(tx as unknown as postgres.Sql)
        throw new Rollback()
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e
      })
    return out
  } finally {
    await sql.end({ timeout: 5 })
  }
}
class Rollback extends Error {}
```

`test/schema.test.ts`:

```ts
import { expect, it, describe } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function seedConversation(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  return c
}

describeDb('schema invariants', () => {
  it('allows only one active turn per conversation', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key)
                values (${c.id}, ${USER}, 'a')`
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key)
            values (${c.id}, ${USER}, 'b')`,
      ).rejects.toThrow(/turns_one_active_per_conversation/)
    })
  })

  it('allows a new turn once the previous one is done', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${c.id}, ${USER}, 'a', 'done')`
      const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                            values (${c.id}, ${USER}, 'b') returning id`
      expect(t.id).toBeTruthy()
    })
  })

  it('deduplicates on idempotency key — the 50-button-presses guard', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${c.id}, ${USER}, 'same', 'done')`
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key, status)
            values (${c.id}, ${USER}, 'same', 'done')`,
      ).rejects.toThrow(/idempotency/)
    })
  })

  it('refuses a turn whose user_id does not match its conversation', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key)
            values (${c.id}, '22222222-2222-2222-2222-222222222222', 'x')`,
      ).rejects.toThrow()
    })
  })

  it('refuses negative spend', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await expect(
        sql`update conversations set spend_usd_micros = -1 where id = ${c.id}`,
      ).rejects.toThrow()
    })
  })

  it('refuses an unknown turn status', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key, status)
            values (${c.id}, ${USER}, 'x', 'Running')`,   // wrong case: stranded forever
      ).rejects.toThrow()
    })
  })
})
```

- [ ] **Step 3: Apply the migration and run**

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_harness.sql
pnpm test schema
```

Expected: all passing. If `DATABASE_URL` is unset the suite skips rather than fails.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_harness.sql test/schema.test.ts test/helpers/db.ts
git commit -m "feat: harness schema with composite owner FKs and active-turn uniqueness"
```

---

### Task 5: The engine — pure turn decisions

**Files:**
- Create: `src/engine.ts`
- Test: `test/engine.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type TurnState = { step: number; messages: LoopMessage[]; reviewRounds: number }`
  - `type Decision = { kind: 'call_model' } | { kind: 'park'; message: string } | { kind: 'stop'; reason: FailReason } | { kind: 'continue_later' }`
  - `decideNext(input: DecideInput): Decision`
  - `type DecideInput = { state: TurnState; spend: { conversationMicros: bigint; dailyMicros: bigint }; limits: Limits; nowMs: number; deadlineMs: number; estStepMs: number; pendingUserMessage: string | null }`

`decideNext` has no I/O and takes no clock of its own — the shell hands in `nowMs`. Its tests need no mocks, which is the point of the engine/shell split.

- [ ] **Step 1: Write the failing test**

`test/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideNext, type DecideInput } from '../src/engine.js'

const LIMITS = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50
  maxSteps: 24,
}

const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  state: { step: 0, messages: [], reviewRounds: 0 },
  spend: { conversationMicros: 0n, dailyMicros: 0n },
  limits: LIMITS,
  nowMs: 1_000,
  deadlineMs: 600_000,
  estStepMs: 60_000,
  pendingUserMessage: null,
  ...over,
})

describe('decideNext', () => {
  it('calls the model when there is room', () => {
    expect(decideNext(base())).toEqual({ kind: 'call_model' })
  })

  it('stops at the conversation ceiling', () => {
    const d = decideNext(base({ spend: { conversationMicros: 8_000_000n, dailyMicros: 0n } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops at the daily ceiling even when the conversation is cheap', () => {
    const d = decideNext(base({ spend: { conversationMicros: 10n, dailyMicros: 15_000_000n } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops at the step cap', () => {
    const d = decideNext(base({ state: { step: 24, messages: [], reviewRounds: 0 } }))
    expect(d).toEqual({ kind: 'stop', reason: 'step_cap' })
  })

  // The 15-minute Netlify ceiling: hand off to a fresh invocation rather than be killed.
  it('continues later when the next step would not fit before the deadline', () => {
    const d = decideNext(base({ nowMs: 550_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'continue_later' })
  })

  it('prefers stopping over continuing when the ceiling is also hit', () => {
    const d = decideNext(base({
      nowMs: 550_000,
      spend: { conversationMicros: 8_000_000n, dailyMicros: 0n },
    }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('is a pure function of its input', () => {
    const input = base()
    const before = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    decideNext(input)
    const after = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    expect(after).toBe(before)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test engine`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/engine.ts`:

```ts
export type LoopMessage = { role: 'user' | 'assistant' | 'tool'; content: string }

export type TurnState = { step: number; messages: LoopMessage[]; reviewRounds: number }

export type FailReason =
  | 'provider_down' | 'fetch_failed' | 'limit_reached' | 'step_cap'
  | 'deadline_exceeded' | 'crash_loop' | 'fenced' | 'stalled'

export type Limits = {
  conversationCeilingMicros: bigint
  dailyCeilingMicros: bigint
  globalCeilingMicros: bigint
  maxSteps: number
}

export type DecideInput = {
  state: TurnState
  spend: { conversationMicros: bigint; dailyMicros: bigint }
  limits: Limits
  nowMs: number
  deadlineMs: number
  estStepMs: number
  pendingUserMessage: string | null
}

export type Decision =
  | { kind: 'call_model' }
  | { kind: 'park'; message: string }
  | { kind: 'stop'; reason: FailReason }
  | { kind: 'continue_later' }

export function decideNext(input: DecideInput): Decision {
  const { state, spend, limits, nowMs, deadlineMs, estStepMs } = input

  // Money first: a ceiling beats every other consideration.
  if (spend.conversationMicros >= limits.conversationCeilingMicros) {
    return { kind: 'stop', reason: 'limit_reached' }
  }
  if (spend.dailyMicros >= limits.dailyCeilingMicros) {
    return { kind: 'stop', reason: 'limit_reached' }
  }
  if (state.step >= limits.maxSteps) {
    return { kind: 'stop', reason: 'step_cap' }
  }
  // Wall clock: hand off to a fresh invocation rather than be killed mid-step.
  if (nowMs + estStepMs >= deadlineMs) {
    return { kind: 'continue_later' }
  }
  return { kind: 'call_model' }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test engine`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts test/engine.test.ts
git commit -m "feat: pure turn engine with money, step, and deadline decisions"
```

---

### Task 6: The claim, with a fencing token

**Files:**
- Create: `src/repo/turns.ts`
- Test: `test/claim.test.ts`

**Interfaces:**
- Consumes: `postgres.Sql`, `FailReason` from `src/engine.ts`
- Produces:
  - `type Claim = { turnId: string; conversationId: string; userId: string; attempts: number; state: TurnState | null }`
  - `claimTurn(sql, turnId): Promise<Claim | null>` — null means someone else owns it
  - `saveTurnState(sql, claim, state): Promise<void>` — throws `FencedError` when superseded
  - `heartbeat(sql, claim): Promise<void>` — throws `FencedError`
  - `class FencedError extends Error`

The claim is one statement whose `WHERE` names the state it is leaving. `attempts` is both the crash-loop cap and the fencing token.

- [ ] **Step 1: Write the failing test**

`test/claim.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { claimTurn, saveTurnState, FencedError } from '../src/repo/turns.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function seedTurn(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                        values (${c.id}, ${USER}, 'k1') returning *`
  return t
}

describeDb('claimTurn', () => {
  it('claims a queued turn and increments attempts', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      const claim = await claimTurn(sql, t.id)
      expect(claim?.attempts).toBe(1)
    })
  })

  it('refuses a second claim of a live turn', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      expect(await claimTurn(sql, t.id)).not.toBeNull()
      expect(await claimTurn(sql, t.id)).toBeNull()   // the Netlify retry: a silent no-op
    })
  })

  it('reclaims a turn whose heartbeat has gone silent', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      await claimTurn(sql, t.id)
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      const second = await claimTurn(sql, t.id)
      expect(second?.attempts).toBe(2)
    })
  })

  it('refuses to reclaim past the crash-loop cap', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      await sql`update turns set status='running', attempts = 5,
                heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      expect(await claimTurn(sql, t.id)).toBeNull()
    })
  })

  // The lease bug: claiming is exclusive, writing was not.
  it('REJECTS a write from a superseded worker', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      const second = (await claimTurn(sql, t.id))!

      await saveTurnState(sql, second, { step: 3, messages: [], reviewRounds: 0 })

      await expect(
        saveTurnState(sql, first, { step: 1, messages: [], reviewRounds: 0 }),
      ).rejects.toThrow(FencedError)

      const [row] = await sql`select state from turns where id = ${t.id}`
      expect(row.state.step).toBe(3)      // the live worker's state survived
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test claim`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/repo/turns.ts`:

```ts
import type { Sql } from 'postgres'
import type { TurnState } from '../engine.js'

export const HEARTBEAT_STALE = '90 seconds'
export const MAX_ATTEMPTS = 5

export type Claim = {
  turnId: string
  conversationId: string
  userId: string
  attempts: number
  state: TurnState | null
}

export class FencedError extends Error {
  constructor(turnId: string) {
    super(`Turn ${turnId} was claimed by another worker; this worker is superseded`)
    this.name = 'FencedError'
  }
}

/**
 * One statement whose WHERE names the state we are leaving. Postgres re-evaluates
 * the predicate against the row's current state at lock time, so of two concurrent
 * claims exactly one matches. `attempts` doubles as the fencing token.
 */
export async function claimTurn(sql: Sql, turnId: string): Promise<Claim | null> {
  const rows = await sql`
    update turns
       set status = 'running',
           started_at = coalesce(started_at, now()),
           heartbeat_at = now(),
           attempts = attempts + 1
     where id = ${turnId}
       and attempts < ${MAX_ATTEMPTS}
       and (status = 'queued'
            or (status = 'running'
                and heartbeat_at < now() - interval '${sql.unsafe(HEARTBEAT_STALE)}'))
    returning id, conversation_id, user_id, attempts, state`
  const r = rows[0]
  if (!r) return null
  return {
    turnId: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    attempts: r.attempts,
    state: r.state ?? null,
  }
}

export async function saveTurnState(sql: Sql, claim: Claim, state: TurnState): Promise<void> {
  const rows = await sql`
    update turns set state = ${sql.json(state as never)}, heartbeat_at = now()
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}

export async function heartbeat(sql: Sql, claim: Claim): Promise<void> {
  const rows = await sql`
    update turns set heartbeat_at = now()
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test claim`
Expected: all passing, including the fencing test.

- [ ] **Step 5: Commit**

```bash
git add src/repo/turns.ts test/claim.test.ts
git commit -m "feat: turn claim with heartbeat lease and fencing token on every write"
```

---

### Task 7: Turn completion in one transaction, and parking

**Files:**
- Modify: `src/repo/turns.ts`
- Test: `test/completion.test.ts`

**Interfaces:**
- Consumes: `Claim`, `FencedError`
- Produces:
  - `completeTurn(sql, claim, opts: { state: TurnState; agentMessage: string | null; parked: boolean; spendMicros: bigint }): Promise<void>`
  - `failTurn(sql, claim, reason: FailReason): Promise<void>`

The five unbatched writes in the article's `runTurn` can lose finished, billed work: a crash after `finishTurn` and before the message append leaves the turn `done`, the conversation `active`, and no message — and nothing rescues a `done` turn.

- [ ] **Step 1: Write the failing test**

`test/completion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { claimTurn, completeTurn, failTurn, FencedError } from '../src/repo/turns.js'

const USER = '11111111-1111-1111-1111-111111111111'
const EMPTY = { step: 0, messages: [], reviewRounds: 0 }

async function seed(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                        values (${c.id}, ${USER}, 'k') returning *`
  return { c, t }
}

describeDb('completeTurn', () => {
  it('writes the message, the status, and the spend atomically', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await completeTurn(sql, claim, {
        state: EMPTY, agentMessage: 'Two options for Faro.',
        parked: true, spendMicros: 1_250n,
      })

      const [turn] = await sql`select * from turns where id = ${t.id}`
      const [convo] = await sql`select * from conversations where id = ${c.id}`
      const msgs = await sql`select * from messages where conversation_id = ${c.id}`

      expect(turn.status).toBe('done')            // parking is TERMINAL for the turn
      expect(turn.finished_at).not.toBeNull()
      expect(convo.status).toBe('awaiting_user')
      expect(convo.spend_usd_micros).toBe('1250')
      expect(msgs).toHaveLength(1)
      expect(msgs[0].turn_id).toBe(t.id)
    })
  })

  it('leaves the conversation active when the turn is not parking', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await completeTurn(sql, claim, {
        state: EMPTY, agentMessage: null, parked: false, spendMicros: 0n,
      })
      const [convo] = await sql`select status from conversations where id = ${c.id}`
      expect(convo.status).toBe('active')
    })
  })

  it('refuses to complete when fenced, and changes nothing', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      await claimTurn(sql, t.id)

      await expect(
        completeTurn(sql, first, {
          state: EMPTY, agentMessage: 'stale', parked: true, spendMicros: 99n,
        }),
      ).rejects.toThrow(FencedError)

      const msgs = await sql`select * from messages where conversation_id = ${c.id}`
      const [convo] = await sql`select * from conversations where id = ${c.id}`
      expect(msgs).toHaveLength(0)               // no partial write survived
      expect(convo.spend_usd_micros).toBe('0')
    })
  })
})

describeDb('failTurn', () => {
  it('records the reason and surfaces it on the conversation', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await failTurn(sql, claim, 'provider_down')
      const [turn] = await sql`select * from turns where id = ${t.id}`
      const [convo] = await sql`select status from conversations where id = ${c.id}`
      expect(turn.status).toBe('failed')
      expect(turn.fail_reason).toBe('provider_down')
      expect(convo.status).toBe('failed')
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test completion`
Expected: FAIL — `completeTurn` is not exported.

- [ ] **Step 3: Implement**

Append to `src/repo/turns.ts`:

```ts
import type { FailReason } from '../engine.js'

export async function completeTurn(
  sql: Sql,
  claim: Claim,
  opts: {
    state: TurnState
    agentMessage: string | null
    parked: boolean
    spendMicros: bigint
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      update turns
         set status = 'done', state = ${tx.json(opts.state as never)},
             finished_at = now(), heartbeat_at = now(),
             spend_usd_micros = spend_usd_micros + ${opts.spendMicros}
       where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)

    if (opts.agentMessage !== null) {
      await tx`insert into messages (conversation_id, user_id, turn_id, role, content)
               values (${claim.conversationId}, ${claim.userId}, ${claim.turnId},
                       'agent', ${opts.agentMessage})`
    }

    await tx`
      update conversations
         set status = ${opts.parked ? 'awaiting_user' : 'active'},
             spend_usd_micros = spend_usd_micros + ${opts.spendMicros},
             updated_at = now()
       where id = ${claim.conversationId} and user_id = ${claim.userId}`
  })
  // Notification goes here, AFTER commit, and may never fail the turn:
  //   notifyUser(claim.conversationId).catch(logOnly)
}

export async function failTurn(sql: Sql, claim: Claim, reason: FailReason): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      update turns set status = 'failed', fail_reason = ${reason},
                       finished_at = now()
       where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)
    await tx`update conversations set status = 'failed', updated_at = now()
              where id = ${claim.conversationId} and user_id = ${claim.userId}`
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test completion`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/repo/turns.ts test/completion.test.ts
git commit -m "feat: atomic turn completion; parking is terminal for the turn"
```

---

### Task 8: The spend ledger

**Files:**
- Create: `src/repo/spend.ts`, `src/pricing.ts`
- Test: `test/spend.test.ts`

**Interfaces:**
- Consumes: `postgres.Sql`
- Produces:
  - `PRICES: Record<string, { inMicrosPerToken: number; outMicrosPerToken: number; cacheWriteMult: number; cacheReadMult: number }>`
  - `costMicros(model: string, usage: Usage): bigint` where `Usage = { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }`
  - `recordSpend(sql, args): Promise<{ conversationMicros: bigint; dailyMicros: bigint }>` — atomic, returns post-increment values
  - `readSpendFailClosed(sql, userId, conversationId): Promise<{ conversationMicros: bigint; dailyMicros: bigint }>` — throws rather than returning zero

Two bugs this closes: `daily_usage` had no writer at all, and spend was added once at turn end so the per-call check compared against a number stale for the whole turn.

- [ ] **Step 1: Write the failing test**

`test/spend.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { costMicros } from '../src/pricing.js'
import { recordSpend, readSpendFailClosed } from '../src/repo/spend.js'

const USER = '11111111-1111-1111-1111-111111111111'

describe('costMicros', () => {
  it('prices Opus 5 input and output', () => {
    // $5/MTok in, $25/MTok out => 5 and 25 micros per 1k tokens
    const c = costMicros('claude-opus-5', {
      input_tokens: 1_000_000, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 0,
    })
    expect(c).toBe(5_000_000n)          // $5.00
  })

  it('prices cache writes and reads DIFFERENTLY — one column could not', () => {
    const write = costMicros('claude-opus-5', {
      input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0, output_tokens: 0,
    })
    const read = costMicros('claude-opus-5', {
      input_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000, output_tokens: 0,
    })
    expect(write).toBe(6_250_000n)      // 1.25x
    expect(read).toBe(500_000n)         // 0.1x
    expect(Number(write) / Number(read)).toBe(12.5)
  })

  it('does not round a cheap Haiku call to zero', () => {
    const c = costMicros('claude-haiku-4-5-20251001', {
      input_tokens: 500, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 20,
    })
    expect(c).toBeGreaterThan(0n)       // in cents this would have been 0
  })

  it('throws on an unpriced model rather than charging zero', () => {
    expect(() => costMicros('some-future-model', {
      input_tokens: 1, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 1,
    })).toThrow()
  })
})

describeDb('recordSpend', () => {
  it('increments conversation and daily counters atomically and returns totals', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      const a = await recordSpend(sql, {
        userId: USER, conversationId: c.id, costMicros: 1000n,
      })
      expect(a).toEqual({ conversationMicros: 1000n, dailyMicros: 1000n })
      const b = await recordSpend(sql, {
        userId: USER, conversationId: c.id, costMicros: 500n,
      })
      expect(b).toEqual({ conversationMicros: 1500n, dailyMicros: 1500n })
    })
  })

  it('upserts daily usage rather than losing a concurrent increment', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      await Promise.all(
        Array.from({ length: 10 }, () =>
          recordSpend(sql, { userId: USER, conversationId: c.id, costMicros: 100n })),
      )
      const [row] = await sql`select cost_micros from daily_usage where user_id = ${USER}`
      expect(BigInt(row.cost_micros)).toBe(1000n)
    })
  })
})

describeDb('readSpendFailClosed', () => {
  it('returns zeros for a fresh user', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      const s = await readSpendFailClosed(sql, USER, c.id)
      expect(s.dailyMicros).toBe(0n)
    })
  })

  it('throws rather than returning zero when the query fails — the ?? 0 trap', async () => {
    await withTestDb(async (sql) => {
      await expect(
        readSpendFailClosed(sql, USER, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/fail closed/i)
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test spend`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/pricing.ts`:

```ts
export type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

/** USD micros per token. $5/MTok == 5 micros/token. */
export const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
}

export const CACHE_WRITE_MULT = 1.25
export const CACHE_READ_MULT = 0.1

export function costMicros(model: string, u: Usage): bigint {
  const p = PRICES[model]
  if (!p) throw new Error(`No price for model "${model}". Refusing to charge zero.`)
  const micros =
    u.input_tokens * p.in +
    u.cache_creation_input_tokens * p.in * CACHE_WRITE_MULT +
    u.cache_read_input_tokens * p.in * CACHE_READ_MULT +
    u.output_tokens * p.out
  return BigInt(Math.ceil(micros))     // round UP: never undercount a guardrail
}
```

`src/repo/spend.ts`:

```ts
import type { Sql } from 'postgres'

export async function recordSpend(
  sql: Sql,
  args: { userId: string; conversationId: string; costMicros: bigint },
): Promise<{ conversationMicros: bigint; dailyMicros: bigint }> {
  return await sql.begin(async (tx) => {
    const conv = await tx`
      update conversations set spend_usd_micros = spend_usd_micros + ${args.costMicros},
                               updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (conv.length === 0) throw new Error('recordSpend: conversation not found (fail closed)')

    const day = await tx`
      insert into daily_usage (user_id, day, cost_micros)
      values (${args.userId}, current_date, ${args.costMicros})
      on conflict (user_id, day)
        do update set cost_micros = daily_usage.cost_micros + excluded.cost_micros,
                      updated_at = now()
      returning cost_micros`

    return {
      conversationMicros: BigInt(conv[0]!.spend_usd_micros),
      dailyMicros: BigInt(day[0]!.cost_micros),
    }
  })
}

export async function readSpendFailClosed(
  sql: Sql,
  userId: string,
  conversationId: string,
): Promise<{ conversationMicros: bigint; dailyMicros: bigint }> {
  const conv = await sql`
    select spend_usd_micros from conversations
     where id = ${conversationId} and user_id = ${userId}`
  if (conv.length === 0) {
    throw new Error('Cannot confirm conversation spend — fail closed, denying the request')
  }
  const day = await sql`
    select cost_micros from daily_usage where user_id = ${userId} and day = current_date`
  return {
    conversationMicros: BigInt(conv[0]!.spend_usd_micros),
    dailyMicros: day.length ? BigInt(day[0]!.cost_micros) : 0n,
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test spend`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts src/repo/spend.ts test/spend.test.ts
git commit -m "feat: atomic spend ledger in micros with a fail-closed reader"
```

---

### Task 9: Tool-call idempotency

**Files:**
- Create: `src/repo/toolCalls.ts`
- Test: `test/toolCalls.test.ts`

**Interfaces:**
- Consumes: `postgres.Sql`
- Produces:
  - `type ToolCallOutcome<T> = { status: 'fresh' } | { status: 'replayed'; result: T } | { status: 'ambiguous' }`
  - `beginToolCall(sql, turnId, callId, name): Promise<ToolCallOutcome<unknown>>`
  - `finishToolCall(sql, turnId, callId, result): Promise<void>`

State is saved *after* a tool runs, so a kill between the two re-executes it. That means two escalation emails, two proposals she can both accept, two sets of tracked links. The intent to call must be persisted before the call.

- [ ] **Step 1: Write the failing test**

`test/toolCalls.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function seedTurn(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                        values (${c.id}, ${USER}, 'k') returning *`
  return t.id
}

describeDb('tool call idempotency', () => {
  it('reports a first call as fresh', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'explore_flights'))
        .toEqual({ status: 'fresh' })
    })
  })

  it('replays a completed call without re-executing it', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      await beginToolCall(sql, turnId, 'toolu_1', 'explore_flights')
      await finishToolCall(sql, turnId, 'toolu_1', { shortlist: ['a', 'b'] })
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'explore_flights'))
        .toEqual({ status: 'replayed', result: { shortlist: ['a', 'b'] } })
    })
  })

  // The dangerous case: we died mid-side-effect and cannot know if the email was sent.
  it('reports a pending call as ambiguous rather than guessing', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      await beginToolCall(sql, turnId, 'toolu_1', 'escalate_to_human')
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'escalate_to_human'))
        .toEqual({ status: 'ambiguous' })
    })
  })

  it('scopes call ids to their turn', async () => {
    await withTestDb(async (sql) => {
      const a = await seedTurn(sql)
      const b = await seedTurn(sql)
      await beginToolCall(sql, a, 'toolu_1', 'x')
      expect(await beginToolCall(sql, b, 'toolu_1', 'x')).toEqual({ status: 'fresh' })
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test toolCalls`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/repo/toolCalls.ts`:

```ts
import type { Sql } from 'postgres'

export type ToolCallOutcome<T = unknown> =
  | { status: 'fresh' }
  | { status: 'replayed'; result: T }
  | { status: 'ambiguous' }

/**
 * Writes the INTENT to call a tool before the tool runs. On replay:
 *  - done      -> return the stored result, do not execute
 *  - pending   -> the previous attempt died mid-side-effect. Do not guess.
 */
export async function beginToolCall(
  sql: Sql, turnId: string, callId: string, name: string,
): Promise<ToolCallOutcome> {
  const inserted = await sql`
    insert into tool_calls (turn_id, call_id, name, status)
    values (${turnId}, ${callId}, ${name}, 'pending')
    on conflict (turn_id, call_id) do nothing
    returning call_id`
  if (inserted.length > 0) return { status: 'fresh' }

  const existing = await sql`
    select status, result from tool_calls
     where turn_id = ${turnId} and call_id = ${callId}`
  const row = existing[0]!
  if (row.status === 'done') return { status: 'replayed', result: row.result }
  return { status: 'ambiguous' }
}

export async function finishToolCall(
  sql: Sql, turnId: string, callId: string, result: unknown,
): Promise<void> {
  await sql`
    update tool_calls set status = 'done', result = ${sql.json(result as never)}
     where turn_id = ${turnId} and call_id = ${callId}`
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test toolCalls`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/repo/toolCalls.ts test/toolCalls.test.ts
git commit -m "feat: persist tool-call intent before execution so replays cannot repeat effects"
```

---

### Task 10: The sweeper

**Files:**
- Create: `src/sweeper.ts`
- Test: `test/sweeper.test.ts`

**Interfaces:**
- Consumes: `postgres.Sql`
- Produces: `sweep(sql, opts: { batchSize?: number }): Promise<{ requeued: string[]; backlog: number }>`

Three bugs to close: it must see `queued` turns (a failed invocation is otherwise orphaned forever), it must be bounded (or it flips rows it cannot enqueue and then can no longer find them), and it must never resurrect a parked turn.

- [ ] **Step 1: Write the failing test**

`test/sweeper.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { sweep } from '../src/sweeper.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function convo(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  return c.id
}

describeDb('sweep', () => {
  it('requeues a turn whose heartbeat went silent', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status,
                           started_at, heartbeat_at)
        values (${cid}, ${USER}, 'k', 'running',
                now() - interval '10 minutes', now() - interval '10 minutes')
        returning id`
      const out = await sweep(sql, {})
      expect(out.requeued).toContain(t.id)
    })
  })

  // The orphan: the enqueue HTTP call failed, so nothing ever ran this turn.
  it('requeues a turn stuck in queued, which the old sweeper never saw', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status, queued_at)
        values (${cid}, ${USER}, 'k', 'queued', now() - interval '10 minutes')
        returning id`
      const out = await sweep(sql, {})
      expect(out.requeued).toContain(t.id)
    })
  })

  it('does not touch a live turn', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status,
                                   started_at, heartbeat_at)
                values (${cid}, ${USER}, 'k', 'running', now(), now())`
      expect((await sweep(sql, {})).requeued).toHaveLength(0)
    })
  })

  it('does not resurrect a parked turn — the money leak', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      await sql`update conversations set status='awaiting_user' where id=${cid}`
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status,
                                   finished_at, heartbeat_at)
                values (${cid}, ${USER}, 'k', 'done', now() - interval '2 hours',
                        now() - interval '2 hours')`
      expect((await sweep(sql, {})).requeued).toHaveLength(0)
    })
  })

  it('is bounded and reports the remaining backlog', async () => {
    await withTestDb(async (sql) => {
      for (let i = 0; i < 5; i++) {
        const cid = await convo(sql)
        await sql`insert into turns (conversation_id, user_id, idempotency_key, status,
                                     queued_at)
                  values (${cid}, ${USER}, ${'k' + i}, 'queued',
                          now() - interval '10 minutes')`
      }
      const out = await sweep(sql, { batchSize: 2 })
      expect(out.requeued).toHaveLength(2)
      expect(out.backlog).toBe(5)
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test sweeper`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/sweeper.ts`:

```ts
import type { Sql } from 'postgres'

export const QUEUED_STALE = '2 minutes'
export const HEARTBEAT_STALE = '90 seconds'
export const DEFAULT_BATCH = 100

/**
 * Bounded so the whole sweep fits inside a 30s scheduled function. Rows are only
 * flipped once they have been selected, and both arms remain visible to the next
 * sweep, so a killed sweeper never strands the work it was rescuing.
 */
export async function sweep(
  sql: Sql,
  opts: { batchSize?: number } = {},
): Promise<{ requeued: string[]; backlog: number }> {
  const limit = opts.batchSize ?? DEFAULT_BATCH

  const [{ count }] = await sql`
    select count(*)::int as count from turns
     where (status = 'running' and heartbeat_at < now() - interval '${sql.unsafe(HEARTBEAT_STALE)}')
        or (status = 'queued'  and queued_at    < now() - interval '${sql.unsafe(QUEUED_STALE)}')`

  const rows = await sql`
    with batch as (
      select id from turns
       where (status = 'running' and heartbeat_at < now() - interval '${sql.unsafe(HEARTBEAT_STALE)}')
          or (status = 'queued'  and queued_at    < now() - interval '${sql.unsafe(QUEUED_STALE)}')
       order by coalesce(heartbeat_at, queued_at)
       limit ${limit}
       for update skip locked
    )
    update turns t set status = 'queued', queued_at = now()
      from batch where t.id = batch.id
    returning t.id`

  return { requeued: rows.map((r) => r.id as string), backlog: count as number }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test sweeper`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/sweeper.ts test/sweeper.test.ts
git commit -m "feat: bounded sweeper that sees queued turns and spares parked ones"
```

---

### Task 11: The request handler (tier 2)

**Files:**
- Create: `src/handler.ts`
- Test: `test/handler.test.ts`

**Interfaces:**
- Consumes: `readSpendFailClosed`, `Limits`, `postgres.Sql`
- Produces: `submitMessage(deps, input): Promise<SubmitResult>` where
  - `deps = { sql: Sql; limits: Limits; invoke: (turnId: string) => Promise<void>; now: () => Date }`
  - `input = { userId: string; conversationId: string | null; message: string; idempotencyKey: string }`
  - `SubmitResult = { conversationId: string; turnId: string; status: 'queued' | 'duplicate' | 'limit_reached' | 'busy' }`

`invoke` is injected so tests never make an HTTP call. It is deliberately allowed to fail: the turn row is already durable and the sweeper is the backstop.

- [ ] **Step 1: Write the failing test**

`test/handler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = {
  conversationCeilingMicros: 8_000_000n,
  dailyCeilingMicros: 15_000_000n,
  globalCeilingMicros: 50_000_000n,
  maxSteps: 24,
}
const deps = (sql: any, invoke = vi.fn().mockResolvedValue(undefined)) => ({
  sql, limits: LIMITS, invoke, now: () => new Date('2026-09-01T10:00:00Z'),
})

describeDb('submitMessage', () => {
  it('creates a conversation, a message, and a queued turn, then invokes', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null,
        message: 'a week in Portugal in September', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
      const msgs = await sql`select * from messages where conversation_id = ${r.conversationId}`
      expect(msgs[0].role).toBe('user')
    })
  })

  it('returns the same turn for a duplicate idempotency key', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'same',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'hi', idempotencyKey: 'same',
      })
      expect(b.status).toBe('duplicate')
      expect(b.turnId).toBe(a.turnId)
    })
  })

  it('refuses a second turn while one is in flight', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'one', idempotencyKey: 'i1',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'two', idempotencyKey: 'i2',
      })
      expect(b.status).toBe('busy')
    })
  })

  it('denies when the daily ceiling is reached, before spending anything', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER}, current_date, 15000000)`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  // The turn is durable before invoke runs; the sweeper is the backstop.
  it('still reports queued when the invocation fails', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockRejectedValue(new Error('502 from Netlify'))
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      const [t] = await sql`select status from turns where id = ${r.turnId}`
      expect(t.status).toBe('queued')
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test handler`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/handler.ts`:

```ts
import type { Sql } from 'postgres'
import type { Limits } from './engine.js'
import { readSpendFailClosed } from './repo/spend.js'

export type SubmitDeps = {
  sql: Sql
  limits: Limits
  invoke: (turnId: string) => Promise<void>
  now: () => Date
}

export type SubmitInput = {
  userId: string
  conversationId: string | null
  message: string
  idempotencyKey: string
}

export type SubmitResult = {
  conversationId: string
  turnId: string
  status: 'queued' | 'duplicate' | 'limit_reached' | 'busy'
}

export async function submitMessage(
  deps: SubmitDeps, input: SubmitInput,
): Promise<SubmitResult> {
  const { sql, limits } = deps

  const conversationId = input.conversationId ?? (
    await sql`insert into conversations (user_id) values (${input.userId}) returning id`
  )[0]!.id as string

  // Fail closed: this throws rather than returning zero when it cannot confirm.
  const spend = await readSpendFailClosed(sql, input.userId, conversationId)
  if (spend.dailyMicros >= limits.dailyCeilingMicros ||
      spend.conversationMicros >= limits.conversationCeilingMicros) {
    await sql`update conversations set status = 'limit_reached', updated_at = now()
               where id = ${conversationId} and user_id = ${input.userId}`
    return { conversationId, turnId: '', status: 'limit_reached' }
  }

  await sql`insert into messages (conversation_id, user_id, role, content)
            values (${conversationId}, ${input.userId}, 'user', ${input.message})`

  const inserted = await sql`
    insert into turns (conversation_id, user_id, idempotency_key)
    values (${conversationId}, ${input.userId}, ${input.idempotencyKey})
    on conflict do nothing
    returning id`

  if (inserted.length === 0) {
    const dupe = await sql`
      select id from turns
       where conversation_id = ${conversationId} and idempotency_key = ${input.idempotencyKey}`
    if (dupe.length > 0) {
      return { conversationId, turnId: dupe[0]!.id as string, status: 'duplicate' }
    }
    return { conversationId, turnId: '', status: 'busy' }   // another turn is in flight
  }

  const turnId = inserted[0]!.id as string
  await sql`update conversations set status = 'working', updated_at = now()
             where id = ${conversationId} and user_id = ${input.userId}`

  // Persist first, then schedule. A failed invoke leaves a durable queued turn
  // that the sweeper will pick up within a couple of minutes.
  await deps.invoke(turnId).catch(() => {})

  return { conversationId, turnId, status: 'queued' }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test handler`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts test/handler.test.ts
git commit -m "feat: request handler with fail-closed limits and durable-before-invoke ordering"
```

---

### Task 12: The worker loop with an echo agent, and the end-to-end proof

**Files:**
- Create: `src/worker.ts`
- Create: `netlify/functions/run-turn-background.mts`
- Create: `netlify/functions/sweep.mts`
- Create: `netlify.toml`
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `type Agent = (ctx: AgentContext) => Promise<AgentStep>` where `AgentStep = { kind: 'message'; text: string; costMicros: bigint } | { kind: 'tool'; callId: string; name: string; run: () => Promise<unknown>; costMicros: bigint }`
  - `runTurn(deps, turnId): Promise<void>`
  - `echoAgent: Agent`

The echo agent proves the whole harness without a model or a supplier. Plan 3 replaces it with the real fleet; nothing else changes.

- [ ] **Step 1: Write the failing test**

`test/worker.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { runTurn, echoAgent } from '../src/worker.js'
import { claimTurn } from '../src/repo/turns.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = {
  conversationCeilingMicros: 8_000_000n,
  dailyCeilingMicros: 15_000_000n,
  globalCeilingMicros: 50_000_000n,
  maxSteps: 24,
}
const workerDeps = (sql: any, agent = echoAgent) => ({
  sql, limits: LIMITS, agent,
  now: () => Date.now(),
  deadlineMs: () => Date.now() + 600_000,
  reinvoke: vi.fn().mockResolvedValue(undefined),
})

async function submit(sql: any, message = 'hello') {
  return submitMessage(
    { sql, limits: LIMITS, invoke: async () => {}, now: () => new Date() },
    { userId: USER, conversationId: null, message, idempotencyKey: 'i1' },
  )
}

describeDb('runTurn end to end', () => {
  it('produces an agent reply and parks the conversation', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'a week in Portugal')
      await runTurn(workerDeps(sql), r.turnId)

      const msgs = await sql`select * from messages
                              where conversation_id = ${r.conversationId} order by created_at`
      const [convo] = await sql`select * from conversations where id = ${r.conversationId}`
      const [turn] = await sql`select * from turns where id = ${r.turnId}`

      expect(msgs.map((m: any) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1].content).toContain('a week in Portugal')
      expect(convo.status).toBe('awaiting_user')
      expect(turn.status).toBe('done')
      expect(BigInt(convo.spend_usd_micros)).toBeGreaterThan(0n)
    })
  })

  it('walks away when another worker owns the turn', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await claimTurn(sql, r.turnId)                  // someone else got there first
      await runTurn(workerDeps(sql), r.turnId)        // must not throw
      const msgs = await sql`select * from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)                    // no agent reply written
    })
  })

  it('does not repeat a completed tool call on resume', async () => {
    await withTestDb(async (sql) => {
      const sideEffect = vi.fn().mockResolvedValue({ ok: true })
      let handedOut = false
      const agent = async () => {
        if (!handedOut) {
          handedOut = true
          return {
            kind: 'tool' as const, callId: 'toolu_1', name: 'escalate_to_human',
            run: sideEffect, costMicros: 10n,
          }
        }
        return { kind: 'message' as const, text: 'done', costMicros: 10n }
      }

      const r = await submit(sql)
      await runTurn(workerDeps(sql, agent), r.turnId)
      expect(sideEffect).toHaveBeenCalledTimes(1)

      // Simulate a crash-and-resume: reopen the turn and run it again.
      await sql`update turns set status='running', heartbeat_at = now() - interval '5 minutes'
                 where id = ${r.turnId}`
      handedOut = false
      await runTurn(workerDeps(sql, agent), r.turnId)
      expect(sideEffect).toHaveBeenCalledTimes(1)     // NOT twice
    })
  })

  it('stops and records limit_reached when the ceiling is hit mid-turn', async () => {
    await withTestDb(async (sql) => {
      const greedy = async () => ({
        kind: 'message' as const, text: 'x', costMicros: 9_000_000n,   // over the $8 ceiling
      })
      const r = await submit(sql)
      await sql`update conversations set spend_usd_micros = 8000000
                 where id = ${r.conversationId}`
      await runTurn(workerDeps(sql, greedy), r.turnId)
      const [turn] = await sql`select * from turns where id = ${r.turnId}`
      expect(turn.fail_reason).toBe('limit_reached')
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test worker`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker.ts`:

```ts
import type { Sql } from 'postgres'
import { decideNext, type Limits, type TurnState } from './engine.js'
import { claimTurn, saveTurnState, completeTurn, failTurn, FencedError, type Claim }
  from './repo/turns.js'
import { recordSpend, readSpendFailClosed } from './repo/spend.js'
import { beginToolCall, finishToolCall } from './repo/toolCalls.js'

export type AgentContext = { state: TurnState; conversationId: string; userId: string }

export type AgentStep =
  | { kind: 'message'; text: string; costMicros: bigint }
  | { kind: 'tool'; callId: string; name: string; run: () => Promise<unknown>; costMicros: bigint }

export type Agent = (ctx: AgentContext) => Promise<AgentStep>

export type WorkerDeps = {
  sql: Sql
  limits: Limits
  agent: Agent
  now: () => number
  deadlineMs: () => number
  reinvoke: (turnId: string) => Promise<void>
}

const EST_STEP_MS = 60_000
const EMPTY: TurnState = { step: 0, messages: [], reviewRounds: 0 }

/** Proves the harness without a model: echoes the last user message back. */
export const echoAgent: Agent = async ({ state }) => {
  const last = [...state.messages].reverse().find((m) => m.role === 'user')
  return {
    kind: 'message',
    text: `You said: ${last?.content ?? '(nothing)'}`,
    costMicros: 1_000n,
  }
}

export async function runTurn(deps: WorkerDeps, turnId: string): Promise<void> {
  const { sql } = deps
  const claim = await claimTurn(sql, turnId)
  if (!claim) return                       // another worker owns it; walk away silently

  try {
    await loop(deps, claim)
  } catch (err) {
    if (err instanceof FencedError) return // superseded: write nothing
    await failTurn(sql, claim, 'provider_down').catch(() => {})
    throw err
  }
}

async function loop(deps: WorkerDeps, claim: Claim): Promise<void> {
  const { sql, limits } = deps
  let state: TurnState = claim.state ?? { ...EMPTY }

  if (state.messages.length === 0) {
    const rows = await sql`
      select role, content from messages
       where conversation_id = ${claim.conversationId} order by created_at`
    state = { ...state, messages: rows.map((r) => ({ role: r.role, content: r.content })) as never }
  }

  for (;;) {
    const spend = await readSpendFailClosed(sql, claim.userId, claim.conversationId)
    const decision = decideNext({
      state, spend, limits,
      nowMs: deps.now(), deadlineMs: deps.deadlineMs(), estStepMs: EST_STEP_MS,
      pendingUserMessage: null,
    })

    if (decision.kind === 'stop') { await failTurn(sql, claim, decision.reason); return }

    if (decision.kind === 'continue_later') {
      await saveTurnState(sql, claim, state)     // persist FIRST
      await deps.reinvoke(claim.turnId)          // then schedule
      return
    }

    const step = await deps.agent({
      state, conversationId: claim.conversationId, userId: claim.userId,
    })

    if (step.kind === 'message') {
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
      await completeTurn(sql, claim, {
        state, agentMessage: step.text, parked: true, spendMicros: 0n,
      })
      return
    }

    const outcome = await beginToolCall(sql, claim.turnId, step.callId, step.name)
    let result: unknown
    if (outcome.status === 'replayed') {
      result = outcome.result
    } else if (outcome.status === 'ambiguous') {
      await failTurn(sql, claim, 'fenced')
      return
    } else {
      result = await step.run()
      await finishToolCall(sql, claim.turnId, step.callId, result)
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
    }

    state = {
      ...state,
      step: state.step + 1,
      messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
    }
    await saveTurnState(sql, claim, state)
  }
}
```

`netlify.toml`:

```toml
[build]
  command = "pnpm build"
  publish = ".next"

[functions]
  node_bundler = "esbuild"

[functions."sweep"]
  schedule = "*/5 * * * *"
```

`netlify/functions/run-turn-background.mts` — reads the shared secret, opens a `postgres` client, and calls `runTurn`. `netlify/functions/sweep.mts` — calls `sweep()` and fires bounded-concurrency re-invocations.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: everything passing.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts netlify/ netlify.toml test/worker.test.ts
git commit -m "feat: worker loop with echo agent, proving the harness end to end"
```

---

## Self-review

**Spec coverage.** §6 schema → Task 4 (slice-1 subset; `tool_results`, `proposals`, `gate_results`, `link_clicks`, `conversions` belong to plans 2–3, where they are first used). §7 tiers → Tasks 11–12; claim and fencing → Task 6; sweeper → Task 10; completion transaction → Task 7; deadline handling → Tasks 5 and 12. §8 spend → Tasks 5 and 8. Notebook provenance (§10) → Task 3. Currency (Global Constraints) → Task 2.

**Deliberately deferred, and where:** RLS policies and the two-user isolation test need `auth.users` and a Supabase-authenticated client — they land in plan 4 with the UI, and Task 4's composite owner FKs are what make those policies expressible. `model_calls` is created in Task 4 but not written until plan 3 introduces a real model call; the fail-closed reader in Task 8 already reads the counters it will feed. Prompt-caching breakpoints, `effort` per seat, and the drift canary are plan 3. Output sanitisation and the URL host allowlist are plans 3–4.

**Placeholders:** none. Every code step contains runnable code; every test step contains real assertions.

**Type consistency:** `TurnState`, `Limits`, and `FailReason` are defined once in `src/engine.ts` and imported everywhere. `Claim` is defined in `src/repo/turns.ts` and consumed by Tasks 7 and 12. `Money` is defined in Task 2 and consumed by Task 3. `Usage` is defined in `src/pricing.ts` and matches the Anthropic field names exactly, so plan 3 can pass `response.usage` straight in.

**Known gap to close in plan 2:** `decideNext` accepts `pendingUserMessage` but does not yet use it — it exists so the real loop can distinguish "park and wait" from "she already replied". Task 5's tests pin the current behaviour; plan 2 extends both together.
