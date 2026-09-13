import { describe, expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import {
  outputBand, fingerprint, diffCanary, reduceShape, goldenArgs, runDriftMonitor,
} from '../src/monitor/drift.js'
import {
  previousCanaryRun, ensureOpsConversation, OPS_USER_ID, type CanaryRun,
} from '../src/repo/drift.js'
import { buildRequest } from '../src/model/client.js'
import { LogNotifier, type Notifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { ModelResult } from '../src/model/client.js'

const HAIKU = 'claude-haiku-4-5-20251001'
const OPUS = 'claude-opus-5'
const NOW = new Date('2026-09-13T12:00:00Z')

// ---------------------------------------------------------------------------
// Pure: outputBand
// ---------------------------------------------------------------------------
describe('outputBand', () => {
  it.each([
    [0, 'xs'], [50, 'xs'],
    [51, 's'], [200, 's'],
    [201, 'm'], [800, 'm'],
    [801, 'l'], [3000, 'l'],
    [3001, 'xl'], [50_000, 'xl'],
  ] as const)('bands %i output tokens as %s', (tokens, band) => {
    expect(outputBand(tokens)).toBe(band)
  })
})

// ---------------------------------------------------------------------------
// Pure: fingerprint
// ---------------------------------------------------------------------------
const usage = (output_tokens = 40) =>
  ({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens })

describe('fingerprint', () => {
  it('driver: signal is the first tool_use block\'s name', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'tool_use', model: OPUS, requestId: 'req-1', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: 'thinking about it' }, { type: 'tool_use', id: 't1', name: 'explore_flights', input: {} }],
    }
    expect(fingerprint('driver', result)).toEqual({
      seat: 'driver', model: OPUS, stopReason: 'tool_use', outputBand: 'xs', signal: 'explore_flights',
    })
  })

  it('driver: signal is "text" when there is no tool_use', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'end_turn', model: OPUS, requestId: 'req-2', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: 'Here is my answer.' }],
    }
    expect(fingerprint('driver', result).signal).toBe('text')
  })

  it('reviewer: signal is approved+issues count, parsed from the JSON text', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'end_turn', model: OPUS, requestId: 'req-3', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: JSON.stringify({ approved: false, issues: ['a', 'b'] }) }],
    }
    expect(fingerprint('reviewer', result).signal).toBe('approved:false/issues:2')
  })

  it('reviewer: unparseable text becomes "unparseable"', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'end_turn', model: OPUS, requestId: 'req-4', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: 'not json at all' }],
    }
    expect(fingerprint('reviewer', result).signal).toBe('unparseable')
  })

  it('front_desk: signal is the parsed label', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'end_turn', model: HAIKU, requestId: 'req-5', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: JSON.stringify({ label: 'new_trip', answer: null, title: 'Portugal' }) }],
    }
    expect(fingerprint('front_desk', result).signal).toBe('new_trip')
  })

  it('front_desk: a shape with no label becomes "unparseable"', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'end_turn', model: HAIKU, requestId: 'req-6', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: '{}' }],
    }
    expect(fingerprint('front_desk', result).signal).toBe('unparseable')
  })

  it('scout: signal is always empty', () => {
    const result: ModelResult = {
      kind: 'ok', stopReason: 'end_turn', model: HAIKU, requestId: 'req-7', usage: usage(), latencyMs: 1,
      content: [{ type: 'text', text: 'Faro is a lovely gateway to the Algarve.' }],
    }
    expect(fingerprint('scout', result).signal).toBe('')
  })

  it('a refusal: stopReason "refusal", signal empty, band from output_tokens, model from result.model', () => {
    const result: ModelResult = {
      kind: 'refused', category: 'other', explanation: null, model: OPUS, requestId: 'req-8', usage: usage(600), latencyMs: 1,
    }
    expect(fingerprint('driver', result)).toEqual({
      seat: 'driver', model: OPUS, stopReason: 'refusal', outputBand: 'm', signal: '',
    })
  })
})

// ---------------------------------------------------------------------------
// Pure: diffCanary
// ---------------------------------------------------------------------------
const base: CanaryRun = {
  seat: 'driver', model: OPUS, stopReason: 'tool_use', outputBand: 'm', signal: 'explore_flights', requestId: 'r',
}

describe('diffCanary', () => {
  it('null on identical runs', () => {
    expect(diffCanary(base, { ...base })).toBeNull()
  })
  it('null when there is no previous run at all', () => {
    expect(diffCanary(null, base)).toBeNull()
  })
  it('a detail when the model changes', () => {
    expect(diffCanary(base, { ...base, model: 'claude-opus-6' })).not.toBeNull()
  })
  it('a detail when the stop reason changes', () => {
    expect(diffCanary(base, { ...base, stopReason: 'end_turn' })).not.toBeNull()
  })
  it('a detail when the signal changes', () => {
    expect(diffCanary(base, { ...base, signal: 'ask_user' })).not.toBeNull()
  })
  it('null on a one-band move', () => {
    expect(diffCanary({ ...base, outputBand: 's' }, { ...base, outputBand: 'm' })).toBeNull()
  })
  it('a detail on a two-band move', () => {
    expect(diffCanary({ ...base, outputBand: 'xs' }, { ...base, outputBand: 'm' })).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: reduceShape
// ---------------------------------------------------------------------------
describe('reduceShape', () => {
  const req = () => ({
    model: OPUS,
    max_tokens: 16_000,
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [
      { name: 'b_tool', description: 'x', input_schema: {} },
      { name: 'a_tool', description: 'y', input_schema: {} },
    ],
    thinking: { type: 'adaptive' },
  })

  it('drops messages', () => {
    expect(reduceShape(req())).not.toHaveProperty('messages')
  })
  it('maps tools to a sorted array of names', () => {
    expect(reduceShape(req()).tools).toEqual(['a_tool', 'b_tool'])
  })
  it('maps a server tool with no name to its type', () => {
    const r = { ...req(), tools: [{ type: 'web_search_20260209', max_uses: 3 }] }
    expect(reduceShape(r).tools).toEqual(['web_search_20260209'])
  })
  it('keeps system as is, cache TTL included', () => {
    const reduced = reduceShape(req())
    expect((reduced.system as { cache_control: { ttl: string } }[])[0]!.cache_control.ttl).toBe('1h')
  })
  it('keeps every other top-level key untouched', () => {
    expect(reduceShape(req()).max_tokens).toBe(16_000)
    expect(reduceShape(req()).thinking).toEqual({ type: 'adaptive' })
  })
  it('differs when the cache TTL changes', () => {
    const a = JSON.stringify(reduceShape(req()))
    const b = JSON.stringify(reduceShape({
      ...req(), system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    }))
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// DB: runDriftMonitor
// ---------------------------------------------------------------------------
function driverResponse(toolName = 'explore_flights') {
  return {
    model: OPUS, stop_reason: 'tool_use', _request_id: 'req-driver',
    usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 60 },
    content: [{ type: 'tool_use', id: 't1', name: toolName, input: {} }],
  }
}
function reviewerResponse(verdict: { approved: boolean; issues: string[] } = { approved: true, issues: [] }) {
  return {
    model: OPUS, stop_reason: 'end_turn', _request_id: 'req-reviewer',
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 },
    content: [{ type: 'text', text: JSON.stringify(verdict) }],
  }
}
function frontDeskResponse(label: 'new_trip' | 'faq' | 'unclear' = 'new_trip') {
  return {
    model: HAIKU, stop_reason: 'end_turn', _request_id: 'req-front',
    usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 },
    content: [{
      type: 'text',
      text: JSON.stringify({ label, answer: label === 'faq' ? 'answer' : null, title: label === 'new_trip' ? 'Portugal trip' : null }),
    }],
  }
}
function scoutResponse(text = 'Faro is nice.') {
  return {
    model: HAIKU, stop_reason: 'end_turn', _request_id: 'req-scout',
    usage: {
      input_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50,
      server_tool_use: { web_search_requests: 1 },
    },
    content: [{ type: 'text', text }],
  }
}

type TransportOverrides = {
  driverTool?: string
  reviewerVerdict?: { approved: boolean; issues: string[] }
  frontLabel?: 'new_trip' | 'faq' | 'unclear'
  scoutText?: string
}
function makeTransport(overrides: TransportOverrides = {}) {
  const create = vi.fn().mockImplementation(async (req: unknown) => {
    const r = req as Record<string, unknown>
    const tools = (r.tools ?? []) as Record<string, unknown>[]
    const hasWebSearch = tools.some((t) => t.name === 'web_search')
    // NOT `output_config !== undefined` — the driver ALSO gets an `output_config`
    // (it carries `effort`, buildRequest's `outputConfig.effort`), so that alone
    // does not distinguish it from front_desk/reviewer. Only a JSON-schema seat
    // sets `output_config.format`.
    const outputConfig = r.output_config as Record<string, unknown> | undefined
    const hasOutputSchema = outputConfig?.format !== undefined
    if (hasWebSearch) return scoutResponse(overrides.scoutText)
    if (r.model === HAIKU && hasOutputSchema) return frontDeskResponse(overrides.frontLabel)
    if (r.model === OPUS && hasOutputSchema) return reviewerResponse(overrides.reviewerVerdict)
    return driverResponse(overrides.driverTool)
  })
  return { create }
}

async function seedTraveller(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-00000000f00${n}`
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id, spend_usd_micros`
  return { userId, conversationId: c!.id as string, spend: BigInt(c!.spend_usd_micros as string) }
}

const deps = (sql: postgres.Sql, transport: { create: (req: unknown) => Promise<unknown> }, notifier: Notifier = new LogNotifier(() => {})) =>
  ({ sql, transport, limits: DEFAULT_LIMITS, now: () => NOW.getTime(), notifier })

describeDb('runDriftMonitor', () => {
  it('first run: records four canary rows and zero alarms (no previous)', async () => {
    await withTestDb(async (sql) => {
      const traveller = await seedTraveller(sql, '1')
      const out = await runDriftMonitor(deps(sql, makeTransport()))
      expect(out.runs).toHaveLength(4)
      expect(out.alarms).toHaveLength(0)
      expect(out.skipped).toHaveLength(0)
      const rows = await sql`select seat from canary_runs order by seat`
      expect(rows.map((r) => r.seat as string).sort()).toEqual(['driver', 'front_desk', 'reviewer', 'scout'])
      const [t] = await sql`select spend_usd_micros from conversations where id = ${traveller.conversationId}`
      expect(BigInt(t!.spend_usd_micros as string)).toBe(traveller.spend)
    })
  })

  it('second run: a changed driver tool name records one canary alarm, notifies once, stamps notified_at', async () => {
    await withTestDb(async (sql) => {
      const alarmFn = vi.fn().mockResolvedValue(undefined)
      const notifier: Notifier = { notify: vi.fn(), alarm: alarmFn }
      await runDriftMonitor(deps(sql, makeTransport({ driverTool: 'explore_flights' }), notifier))
      const out = await runDriftMonitor(deps(sql, makeTransport({ driverTool: 'propose_itinerary' }), notifier))
      expect(out.alarms).toHaveLength(1)
      expect(out.alarms[0]).toMatchObject({ seat: 'driver', check: 'canary' })
      expect(alarmFn).toHaveBeenCalledTimes(1)
      const [row] = await sql`select notified_at from drift_alarms where id = ${out.alarms[0]!.id}`
      expect(row!.notified_at).not.toBeNull()
    })
  }, 15_000)

  it('charges the ops conversation for OPS_USER_ID; a traveller conversation is untouched', async () => {
    await withTestDb(async (sql) => {
      const traveller = await seedTraveller(sql, '2')
      await runDriftMonitor(deps(sql, makeTransport()))
      const opsConversationId = await ensureOpsConversation(sql)
      const [ops] = await sql`select spend_usd_micros from conversations where id = ${opsConversationId} and user_id = ${OPS_USER_ID}`
      expect(ops).toBeDefined()
      const calls = await sql`select cost_micros from model_calls where conversation_id = ${opsConversationId}`
      const summed = calls.reduce((acc, r) => acc + BigInt(r.cost_micros as string), 0n)
      expect(BigInt(ops!.spend_usd_micros as string)).toBe(summed)
      expect(summed).toBeGreaterThan(0n)
      const [t] = await sql`select spend_usd_micros from conversations where id = ${traveller.conversationId}`
      expect(BigInt(t!.spend_usd_micros as string)).toBe(traveller.spend)
    })
  })

  it('a seeded driver request_shape off by one in max_tokens produces a shape alarm', async () => {
    await withTestDb(async (sql) => {
      const golden = buildRequest(goldenArgs('driver'))
      const bad = { ...golden, max_tokens: (golden.max_tokens as number) + 1 }
      const conversationId = await ensureOpsConversation(sql)
      await sql`insert into model_calls (
                  conversation_id, user_id, seat, prompt_version, model_config_id, model, request_shape, capture_policy
                ) values (
                  ${conversationId}, ${OPS_USER_ID}, 'driver', 'driver@2', 'x', ${OPUS},
                  ${sql.json(bad as never)}, 'full'
                )`
      const out = await runDriftMonitor(deps(sql, makeTransport()))
      const shapeAlarms = out.alarms.filter((a) => a.check === 'shape' && a.seat === 'driver')
      expect(shapeAlarms).toHaveLength(1)
    })
  })

  it('a seeded driver request_shape equal to the golden shape produces no shape alarm', async () => {
    await withTestDb(async (sql) => {
      const golden = buildRequest(goldenArgs('driver'))
      const conversationId = await ensureOpsConversation(sql)
      await sql`insert into model_calls (
                  conversation_id, user_id, seat, prompt_version, model_config_id, model, request_shape, capture_policy
                ) values (
                  ${conversationId}, ${OPS_USER_ID}, 'driver', 'driver@2', 'x', ${OPUS},
                  ${sql.json(golden as never)}, 'full'
                )`
      const out = await runDriftMonitor(deps(sql, makeTransport()))
      const shapeAlarms = out.alarms.filter((a) => a.check === 'shape' && a.seat === 'driver')
      expect(shapeAlarms).toHaveLength(0)
    })
  })

  it('a notifier that throws leaves the alarm row unnotified, and the run still completes', async () => {
    await withTestDb(async (sql) => {
      const throwingNotifier: Notifier = { notify: vi.fn(), alarm: vi.fn().mockRejectedValue(new Error('boom')) }
      await runDriftMonitor(deps(sql, makeTransport({ driverTool: 'a_tool' }), throwingNotifier))
      const out = await runDriftMonitor(deps(sql, makeTransport({ driverTool: 'b_tool' }), throwingNotifier))
      expect(out.alarms).toHaveLength(1)
      const [row] = await sql`select notified_at from drift_alarms where id = ${out.alarms[0]!.id}`
      expect(row!.notified_at).toBeNull()
    })
  }, 15_000)

  it('a ceiling reached on the ops user skips canaries, writes no alarm, and leaves a traveller untouched', async () => {
    await withTestDb(async (sql) => {
      const traveller = await seedTraveller(sql, '3')
      const conversationId = await ensureOpsConversation(sql)
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()}
                 where id = ${conversationId}`
      const out = await runDriftMonitor(deps(sql, makeTransport()))
      expect(out.skipped.length).toBeGreaterThan(0)
      expect(out.runs).toHaveLength(0)
      expect(out.alarms).toHaveLength(0)
      const [t] = await sql`select spend_usd_micros from conversations where id = ${traveller.conversationId}`
      expect(BigInt(t!.spend_usd_micros as string)).toBe(traveller.spend)
    })
  })
})

describeDb('ensureOpsConversation', () => {
  it('reuses the newest existing ops conversation rather than creating a new one', async () => {
    await withTestDb(async (sql) => {
      const first = await ensureOpsConversation(sql)
      const second = await ensureOpsConversation(sql)
      expect(second).toBe(first)
    })
  })
})

// Break check: without `order by ran_at desc` (or an equivalent), this query
// has no reason to prefer the row with the later `ran_at` over whichever row
// Postgres happens to scan first — this test pins that it does.
describeDb('previousCanaryRun', () => {
  it('returns the row with the latest ran_at, not the physically-first row', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into canary_runs (seat, model, stop_reason, output_band, signal, request_id, ran_at)
                values ('driver', ${OPUS}, 'tool_use', 'm', 'older', 'r-older', now() - interval '1 day')`
      await sql`insert into canary_runs (seat, model, stop_reason, output_band, signal, request_id, ran_at)
                values ('driver', ${OPUS}, 'tool_use', 'm', 'newer', 'r-newer', now())`
      const prev = await previousCanaryRun(sql, 'driver')
      expect(prev?.signal).toBe('newer')
    })
  })
})
