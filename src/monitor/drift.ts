import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import {
  buildCountTokensRequest, buildRequest, callModel, estimateInputTokens,
  type CallArgs, type ModelResult, type Transport,
} from '../model/client.js'
import { costMicros, PRICES, WEB_SEARCH_MICROS } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import {
  recordCanaryRun, previousCanaryRun, recordAlarm, markAlarmNotified, newestRequestShape,
  ensureOpsConversation, OPS_USER_ID, type CanaryRun, type Band,
} from '../repo/drift.js'
import { toolsForDesk } from '../tools/registry.js'
import { FRONT_SCHEMA } from '../agents/frontDesk.js'
import { REVIEW_SCHEMA, renderOfferForReview } from '../agents/reviewer.js'
import { WEB_SEARCH_TOOL, SCOUT_MAX_SEARCHES, SCOUT_SEARCH_RESULT_TOKENS } from '../agents/scout.js'
import { addMoney, money, type Money } from '../money.js'
import type { RehydratedItem } from '../gates/types.js'
import type { StoredItem } from '../supplier/types.js'
import type { Notifier, DriftAlarm } from '../notify.js'

export { OPS_USER_ID }

/** The four seats the nightly canary calls, one fixed golden request each. */
export type CanarySeat = 'driver' | 'reviewer' | 'front_desk' | 'scout'
const CANARY_SEATS: readonly CanarySeat[] = ['driver', 'reviewer', 'front_desk', 'scout']

/**
 * The three full-capture seats (spec section 4, "cheap seats: canary only") —
 * the only ones whose `model_calls.request_shape` is ever non-null, so the
 * only ones a shape diff can mean anything for.
 */
const SHAPE_SEATS: readonly ('driver' | 'reviewer' | 'front_desk')[] = ['driver', 'reviewer', 'front_desk']

const DRIVER_SYSTEM = readFileSync(new URL('../agents/prompts/driver.md', import.meta.url), 'utf8')
const REVIEWER_SYSTEM = readFileSync(new URL('../agents/prompts/reviewer.md', import.meta.url), 'utf8')
const FRONT_DESK_SYSTEM = readFileSync(new URL('../agents/prompts/front_desk.md', import.meta.url), 'utf8')
const SCOUT_SYSTEM = readFileSync(new URL('../agents/prompts/scout.md', import.meta.url), 'utf8')

/**
 * Fixed "now" for rendering the reviewer's golden offer text. `goldenArgs`
 * takes no clock — it is a pure function of the seat, called fresh every
 * night — and the rendered age-in-minutes text it feeds into is dropped by
 * `reduceShape` anyway (it lives inside `messages`), so any fixed date works;
 * this one is simply readable in a diff.
 */
const GOLDEN_NOW = new Date('2026-01-01T00:00:00Z')

function goldenFlightItem(): StoredItem {
  return {
    sourceId: 'golden-flight', supplier: 'mock', kind: 'flight', name: 'Golden Airline',
    price: money(60_000n, 'EUR'), priceBasis: 'total',
    fetchedAt: GOLDEN_NOW, ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'flight',
      outbound: { from: 'BER', to: 'FAO', departureLocal: '2026-09-12T08:00', arrivalLocal: '2026-09-12T11:00',
                  stops: 0, route: [], cabinClass: 'Economy', carriers: ['LH'], flightNumbers: ['LH1234'] },
      inbound: { from: 'FAO', to: 'BER', departureLocal: '2026-09-19T18:00', arrivalLocal: '2026-09-19T21:00',
                 stops: 0, route: [], cabinClass: 'Economy', carriers: ['LH'], flightNumbers: ['LH5678'] },
      baggage: { personalItem: 1, cabinBag: 1, checkedBag: 0 },
      totalDurationSeconds: 10_800, selfTransfer: false,
    },
    searchParams: null,
  }
}
function goldenHotelItem(): StoredItem {
  return {
    sourceId: 'golden-hotel', supplier: 'mock', kind: 'hotel', name: 'Golden Stay',
    price: money(90_000n, 'EUR'), priceBasis: 'total',
    fetchedAt: GOLDEN_NOW, ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'hotel', checkIn: '2026-09-12', checkOut: '2026-09-19', nights: 7,
      rating: null, coordinates: null, offerSource: null,
    },
    searchParams: null,
  }
}

/** The reviewer's golden offer: one flight, one hotel, hand-built exactly like test/gate-totals-budget-dates.test.ts's fixtures — no supplier, no gates, just a fixed offer to review. */
function goldenReviewOffer(): { items: RehydratedItem[]; total: Money } {
  const flight = goldenFlightItem()
  const hotel = goldenHotelItem()
  const items: RehydratedItem[] = [
    { ref: { sourceId: flight.sourceId, quantity: 1, slot: 'flight' }, item: flight, lineTotal: flight.price },
    { ref: { sourceId: hotel.sourceId, quantity: 1, slot: 'stay' }, item: hotel, lineTotal: hotel.price },
  ]
  return { items, total: addMoney(flight.price, hotel.price) }
}

/**
 * One fixed request per seat, per spec section 4: "a small trip prompt; a
 * small offer to review; a greeting; a city." Pure and deterministic — no
 * clock, no database, no network — so a canary's fingerprint changes only
 * because the MODEL'S ANSWER changed, never because this function did.
 */
export function goldenArgs(seat: CanarySeat): CallArgs {
  switch (seat) {
    case 'driver':
      return {
        seat: SEATS.driver, system: DRIVER_SYSTEM, tools: toolsForDesk('planning'),
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: 'A week in Portugal in September for two adults, under 1500 euros. '
              + 'Start by searching flights from Berlin.',
          }],
        }],
      }
    case 'reviewer': {
      const { items, total } = goldenReviewOffer()
      return {
        seat: SEATS.reviewer, system: REVIEWER_SYSTEM, tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: renderOfferForReview(items, total, GOLDEN_NOW) }] }],
        outputSchema: REVIEW_SCHEMA,
      }
    }
    case 'front_desk':
      return {
        seat: SEATS.front_desk, system: FRONT_DESK_SYSTEM, tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a week in Portugal in September for two' }] }],
        outputSchema: FRONT_SCHEMA,
      }
    case 'scout':
      return {
        seat: SEATS.scout, system: SCOUT_SYSTEM, tools: [WEB_SEARCH_TOOL],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'City: Faro' }] }],
      }
  }
}

/** <=50 xs, <=200 s, <=800 m, <=3000 l, else xl. */
export function outputBand(outputTokens: number): Band {
  if (outputTokens <= 50) return 'xs'
  if (outputTokens <= 200) return 's'
  if (outputTokens <= 800) return 'm'
  if (outputTokens <= 3000) return 'l'
  return 'xl'
}

function signalFor(seat: CanarySeat, result: ModelResult & { kind: 'ok' }): string {
  if (seat === 'driver') {
    const toolUse = result.content.find((b) => b.type === 'tool_use')
    return toolUse !== undefined && toolUse.type === 'tool_use' ? toolUse.name : 'text'
  }
  if (seat === 'scout') return ''
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim()
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'unparseable' }
  if (seat === 'reviewer') {
    const v = raw as { approved?: unknown; issues?: unknown[] }
    if (typeof v.approved === 'boolean' && Array.isArray(v.issues)) {
      return `approved:${v.approved}/issues:${v.issues.length}`
    }
    return 'unparseable'
  }
  // front_desk
  const v = raw as { label?: unknown }
  return typeof v.label === 'string' ? v.label : 'unparseable'
}

/**
 * The response, reduced to a fingerprint — never content. A refusal's signal
 * is always empty: there is no tool name, verdict or label to read out of a
 * declined response, and treating a refusal's absence-of-signal as its own
 * distinct value (rather than, say, throwing) is what lets `diffCanary` catch
 * "this seat started refusing its golden prompt" as a `stopReason` change.
 */
export function fingerprint(seat: CanarySeat, result: ModelResult): Omit<CanaryRun, 'requestId'> {
  const band = outputBand(result.usage.output_tokens)
  if (result.kind === 'refused') {
    return { seat, model: result.model, stopReason: 'refusal', outputBand: band, signal: '' }
  }
  return { seat, model: result.model, stopReason: result.stopReason, outputBand: band, signal: signalFor(seat, result) }
}

const BAND_ORDER: readonly Band[] = ['xs', 's', 'm', 'l', 'xl']

/**
 * Null on identical, a detail on any of {model, stopReason, signal} changing,
 * and a detail on an `outputBand` move of two bands or more (spec section 4).
 * A one-band move is normal variance and not itself alarmed.
 */
export function diffCanary(prev: CanaryRun | null, cur: CanaryRun): Record<string, unknown> | null {
  if (prev === null) return null
  const changed: Record<string, unknown> = {}
  if (prev.model !== cur.model) changed.model = { from: prev.model, to: cur.model }
  if (prev.stopReason !== cur.stopReason) changed.stopReason = { from: prev.stopReason, to: cur.stopReason }
  if (prev.signal !== cur.signal) changed.signal = { from: prev.signal, to: cur.signal }
  const delta = Math.abs(BAND_ORDER.indexOf(cur.outputBand) - BAND_ORDER.indexOf(prev.outputBand))
  if (delta >= 2) changed.outputBand = { from: prev.outputBand, to: cur.outputBand }
  return Object.keys(changed).length > 0 ? changed : null
}

/**
 * The stable part of an assembled request: everything except `messages`
 * (which changes every call by design), with `tools` reduced to names (or
 * `type` for a server tool without one) so a description-wording tweak is
 * not drift. `system` is left exactly as `buildRequest` built it — including
 * the cache TTL — because a TTL change IS a shape a deployed default could
 * silently drift on.
 */
export function reduceShape(req: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...req }
  delete out.messages
  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as Record<string, unknown>[])
      .map((t) => (typeof t.name === 'string' ? t.name : String(t.type)))
      .sort()
  }
  return out
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, canonical(obj[k])]))
  }
  return value
}
/** Deep equality via a key-sorted JSON round trip — order-insensitive at every object level. */
function shapesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** The text she (synthetically) said, for the ledger's `user_prompt` — every golden call carries exactly one user message. */
function userText(args: CallArgs): string {
  return args.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
    .join('\n')
}

export type DriftDeps = {
  sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number; notifier: Notifier
}

/**
 * One canary call, charged to `OPS_USER_ID` exactly like a traveller's seat
 * call: reserve, call, reconcile, record. Returns null — never throws — on a
 * ceiling reached against the ops conversation, so a runaway monitor is
 * capped like everyone else (spec section 4) without ever alarming on its
 * own throttling.
 *
 * Scout alone reserves the search cap (fee plus a bound on the result
 * tokens), mirroring `researchDestination` (src/agents/scout.ts) — the only
 * canary seat whose call can invoke a paid server-side tool.
 */
async function callCanary(deps: DriftDeps, conversationId: string, seat: CanarySeat): Promise<CanaryRun | null> {
  const { sql } = deps
  const seatConfig = SEATS[seat]
  const args = goldenArgs(seat)
  const inputTokens = deps.transport.countTokens
    ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
    : estimateInputTokens(args)

  let extraMicros = 0n
  if (seat === 'scout') {
    const p = PRICES[seatConfig.model]
    if (!p) throw new Error(`No price for model "${seatConfig.model}". Refusing to reserve zero.`)
    const perSearchMicros = WEB_SEARCH_MICROS + BigInt(SCOUT_SEARCH_RESULT_TOKENS * p.inMicrosPerToken)
    extraMicros = BigInt(SCOUT_MAX_SEARCHES) * perSearchMicros
  }
  const reserved = estimateMicros(seatConfig, inputTokens, extraMicros)
  const { conversationMicros, dailyMicros, day } = await reserve(sql, {
    userId: OPS_USER_ID, conversationId, micros: reserved,
  })
  const refund = () => reconcile(sql, { userId: OPS_USER_ID, conversationId, reserved, actual: 0n, day })
  if (firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits) !== null) {
    await refund()
    return null
  }

  let result: ModelResult
  try {
    result = await callModel(deps.transport, args, deps.now)
  } catch (err) {
    if (classifyError(err).billed === 'no') await refund()
    throw err
  }
  const actual = result.kind === 'refused' ? 0n : costMicros(seatConfig.model, result.usage, SYSTEM_CACHE_TTL)
  await reconcile(sql, { userId: OPS_USER_ID, conversationId, reserved, actual, day })
  await recordModelCall(sql, {
    conversationId, turnId: null, userId: OPS_USER_ID,
    seat, seatConfig, result,
    systemPrompt: args.system, userPrompt: userText(args),
    requestShape: buildRequest(args),
    thinkingMode: seatConfig.effort !== null ? 'adaptive' : null,
    costMicros: actual,
  })

  const fp = fingerprint(seat, result)
  return { ...fp, requestId: result.requestId }
}

async function notifyAlarm(deps: DriftDeps, alarm: DriftAlarm): Promise<void> {
  try {
    await deps.notifier.alarm(alarm)
    await markAlarmNotified(deps.sql, alarm.id)
  } catch (err) {
    // Best-effort, like escalations (3b.5): the row is already committed, so
    // a failed notify or a failed stamp must never fail the run.
    console.error('runDriftMonitor: alarm notify/stamp failed', { alarmId: alarm.id, err })
  }
}

/**
 * The nightly job (spec section 4). Two independent checks:
 *
 *  1. Shape, run FIRST and against whatever real production traffic already
 *     wrote — this seat's canary call (below) always matches `goldenArgs`
 *     exactly, so checking shape after recording this run's own canary would
 *     make the check tautological. Checked before the canary loop touches
 *     `model_calls` at all, so "the newest request shape" means the newest
 *     REAL one.
 *  2. Canary, one golden call per seat, fingerprinted and diffed against the
 *     seat's previous stored run.
 *
 * A ceiling reached on the ops conversation skips that seat's canary
 * entirely — no alarm, no fingerprint, no comparison — and is reported back
 * in `skipped` rather than silently dropped.
 */
export async function runDriftMonitor(
  deps: DriftDeps,
): Promise<{ alarms: DriftAlarm[]; runs: CanaryRun[]; skipped: CanarySeat[] }> {
  const { sql } = deps
  const conversationId = await ensureOpsConversation(sql)
  const alarms: DriftAlarm[] = []
  const runs: CanaryRun[] = []
  const skipped: CanarySeat[] = []

  for (const seat of SHAPE_SEATS) {
    const stored = await newestRequestShape(sql, seat)
    if (stored === null) continue
    const golden = reduceShape(buildRequest(goldenArgs(seat)))
    const reducedStored = reduceShape(stored)
    if (!shapesEqual(reducedStored, golden)) {
      const alarm = await recordAlarm(sql, { seat, check: 'shape', detail: { stored: reducedStored, golden } })
      await notifyAlarm(deps, alarm)
      alarms.push(alarm)
    }
  }

  for (const seat of CANARY_SEATS) {
    const prev = await previousCanaryRun(sql, seat)
    const outcome = await callCanary(deps, conversationId, seat)
    if (outcome === null) { skipped.push(seat); continue }
    await recordCanaryRun(sql, outcome)
    runs.push(outcome)
    const detail = diffCanary(prev, outcome)
    if (detail !== null) {
      const alarm = await recordAlarm(sql, { seat, check: 'canary', detail })
      await notifyAlarm(deps, alarm)
      alarms.push(alarm)
    }
  }

  return { alarms, runs, skipped }
}
