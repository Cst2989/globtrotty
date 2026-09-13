import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
// whichCeiling and Limits as well as the transcript types: the batch reads the
// ceiling itself, off the numbers `reserve` returned, which is the whole reason
// the reservation is taken before any call is dispatched.
import { textOfBlocks, whichCeiling, type Limits, type LoopMessage } from '../engine.js'
import { callModel, estimateInputTokens, type CallArgs } from '../model/client.js'
import { costMicros, type Usage } from '../pricing.js'
import { promptVersion } from '../desks.js'
import { pgSink } from '../repo/model-calls.js'
import { estimateBatchMicros, estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { SEATS } from '../seats.js'

/**
 * `import.meta.url`, never `__dirname`: this package is `"type": "module"` with
 * NodeNext resolution, where `__dirname` is undefined. The prompt is a file, so
 * `promptVersion` points at something a person reviews and a prompt change is a
 * reviewable diff. There is no build step here, tsx and vitest only, so the
 * relative URL resolves against the source tree at run time.
 */
const SYSTEM = readFileSync(new URL('./prompts/scout.md', import.meta.url), 'utf8')
const VERSION = promptVersion(SYSTEM)

/** One city and one question, with the search results the driver already has. */
export type ScoutBrief = { city: string; question: string; results: string }

export type ScoutResult = {
  city: string
  /**
   * `${parentCallId}-scout${i}`. It identifies this scout in a log line and in
   * the parent's own returned array, and it is deliberately NOT a
   * `course.tool_calls` key: see `runScouts` below.
   */
  callId: string
  brief: string
  usage: Usage
  costMicros: bigint
}

export type ScoutDeps = {
  sql: postgres.Sql
  client: ModelClient
  conversationId: string
  userId: string
  turnId: string
  /** The parent tool call's id, so every scout's own id derives from it. */
  callId: string
  limits: Limits
  now: () => number
}

/**
 * Thrown when the batch reservation crossed a ceiling, so no call is dispatched.
 *
 * A class rather than a return value, because every caller of `runScouts` wants
 * briefs and none of them wants a union: `scoutRunner` catches this one error
 * and turns it into a tool result the model can act on, which is the same door a
 * gate rejection uses. No new fail reason is added for it, because an unmet
 * reservation is `limit_reached`, which has existed since lesson 2.6.
 */
export class BatchNotReservedError extends Error {
  constructor(readonly ceiling: 'conversation' | 'daily' | 'account') {
    super(`limit_reached: the ${ceiling} ceiling has no room for this batch`)
    this.name = 'BatchNotReservedError'
  }
}

/**
 * Roughly what one brief's prompt costs, before any of them is assembled.
 *
 * Assembled from the LONGEST brief in the batch rather than from an average,
 * because the reservation is a bound and an average is not one. Three cities
 * whose result sets differ by a factor of two would otherwise reserve for the
 * middle one and dispatch the large one.
 *
 * Exported, because `test/scout.test.ts` has to spend a conversation down to
 * exactly the room for two of three and then assert the debit at the moment of
 * the first call. A test that recomputed this number from a formula of its own
 * would be asserting its own arithmetic, and would stay green against a batch
 * that reserved for the average.
 */
export function batchInputTokens(briefs: ScoutBrief[]): number {
  return Math.max(...briefs.map((b) => estimateInputTokens(argsFor(b))))
}

function argsFor(brief: ScoutBrief): CallArgs {
  const messages: LoopMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: `City: ${brief.city}\nQuestion: ${brief.question}\n\n${brief.results}` }],
  }]
  // No tools at all, and that is the design rather than an omission. A scout
  // reads and writes prose; giving it a door would give an untrusted page a way
  // to reach a supplier through a model that was told to summarise it.
  return { seat: SEATS.scout, system: SYSTEM, messages, tools: [] }
}

/**
 * Sends every brief at once, on the cheap seat, under one reservation.
 *
 * ## Why the reservation is taken before any call
 *
 * A per-call check reads a counter the other calls in the batch have not moved
 * yet, so three calls dispatched together all see the same number and all three
 * pass a ceiling that had room for two. Reserving `n` times the per-call bound
 * in one debit is what makes the check see the batch, and it is the same
 * argument as reserving before a single call rather than recording after it,
 * one level up.
 *
 * Reconciled per reply rather than per batch, because that is when the real
 * figure is known and a reply that comes back small should return its refund at
 * once rather than waiting for the slowest sibling.
 *
 * ## Why they run in parallel
 *
 * Three sequential Haiku calls cost the same money and three times the wall
 * clock, and the wall clock is the thing tier 3 has fifteen minutes of. They
 * share nothing: each has its own prompt, its own reply and its own reconcile,
 * so there is no ordering between them to preserve.
 *
 * ## Why not a supervisor
 *
 * A supervisor model that reads three briefs and writes a fourth is a fourth
 * model call, on a seat that has to be at least as capable as the driver to be
 * worth anything, reading exactly the text the driver is about to read anyway.
 * It adds a hop, a failure mode and a place for a summary to lose the one detail
 * that mattered. The driver IS the supervisor here; the scouts are staff.
 *
 * ## What happens when one of them fails
 *
 * Its brief comes back as a sentence saying so, and the other two stand. A
 * `Promise.all` would lose two good briefs to one bad call, and the driver can
 * plan from two cities. The reservation for the failed call is refunded in full
 * only when an error BODY came back, on the same rule the driver uses: an error
 * body carries no usage, so nothing was billed.
 */
export async function runScouts(deps: ScoutDeps, briefs: ScoutBrief[]): Promise<ScoutResult[]> {
  const { sql } = deps
  const perCall = estimateMicros(SEATS.scout, batchInputTokens(briefs))
  const reserved = estimateBatchMicros(SEATS.scout, batchInputTokens(briefs), briefs.length)
  // One debit, for the whole batch, before the first call leaves.
  const { conversationMicros, dailyMicros, day } = await reserve(sql, {
    userId: deps.userId, conversationId: deps.conversationId, micros: reserved,
  })
  // The ceiling reads what the debit RETURNED, so it sees the whole batch. This
  // is the assertion a per-call check cannot make: three calls dispatched
  // together each read a counter the other two have not moved.
  const reached = whichCeiling(
    { conversationMicros, dailyMicros, globalMicros: 0n }, deps.limits)
  if (reached !== null) {
    // Refunded in full, because nothing was dispatched, and then thrown rather
    // than returned: no brief exists to hand back.
    await reconcile(sql, {
      userId: deps.userId, conversationId: deps.conversationId, reserved, actual: 0n, day,
    })
    throw new BatchNotReservedError(reached)
  }

  const settled = await Promise.allSettled(briefs.map(async (brief, i) => {
    /**
     * Derived from the parent's id, and NOT a ledger key.
     *
     * `course.tool_calls` keeps exactly one writer, `ledgerRunner` (ruling 5),
     * and it is wrapped around `scoutRunner` from outside, so the one row this
     * fan-out produces is the parent `research_destination` call's. Writing
     * three more rows from in here would give that table a second writer on the
     * same `(turn_id, call_id)` key, which is the arrangement whose failure mode
     * is a second call reading the first's insert back as `pending`, reporting
     * `ambiguous`, and ending a turn that was fine.
     *
     * A scout is also nothing the ledger exists for: it makes no external side
     * effect worth replaying, and its `course.model_calls` row already records
     * that it happened, at what seat and for how much.
     *
     * So the id identifies this scout in a log line and on its own result, where
     * the parent can name which city said what. The parent's id is the
     * provider's `tool_use` id and is stable across a resume, so these are too.
     */
    const callId = `${deps.callId}-scout${i}`
    const result = await callModel(deps.client, argsFor(brief), deps.now)
    const actual = result.kind === 'refused'
      ? 0n
      : costMicros(SEATS.scout.model, result.usage)
    await reconcile(sql, {
      userId: deps.userId, conversationId: deps.conversationId,
      reserved: perCall, actual, day,
    })
    await pgSink(sql, {
      userId: deps.userId, conversationId: deps.conversationId, turnId: deps.turnId,
    })({
      seat: 'scout', seatConfig: SEATS.scout, promptVersion: VERSION,
      modelRequested: SEATS.scout.model, modelReturned: result.model,
      usage: result.usage, costMicros: actual, latencyMs: result.latencyMs,
    })
    if (result.kind === 'refused') {
      return { city: brief.city, callId, brief: `The scout for ${brief.city} declined to answer.`,
               usage: result.usage, costMicros: actual }
    }
    return {
      city: brief.city, callId, brief: textOfBlocks(result.content).trim(),
      usage: result.usage, costMicros: actual,
    }
  }))

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    // The id is in the log line as well as on the result, because this is the
    // one path where the result is manufactured here rather than returned from
    // the branch above, and a log entry that cannot be matched to a call is the
    // reason the ids exist at all.
    const callId = `${deps.callId}-scout${i}`
    console.error(`runScouts: ${briefs[i]!.city} (${callId}) failed`, s.reason)
    return {
      city: briefs[i]!.city,
      callId,
      brief: `No brief for ${briefs[i]!.city}: the scout call failed. Plan from the other cities `
        + 'or search this one yourself.',
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      costMicros: 0n,
    }
  })
}
