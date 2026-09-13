import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
// whichCeiling and Limits as well as the transcript types: the batch reads the
// ceiling itself, off the numbers `reserve` returned, which is the whole reason
// the reservation is taken before any call is dispatched.
import { textOfBlocks, whichCeiling, type Limits, type LoopMessage } from '../engine.js'
// `isUnbilled` is the driver's own refund rule, and it moved to src/errors.ts in
// this round so the driver and the scouts share one answer to "was this call
// billed?" rather than two copies that can drift.
import { isUnbilled } from '../errors.js'
import { callModel, estimateInputTokens, type CallArgs, type ModelResult } from '../model/client.js'
import { costMicros, type Usage } from '../pricing.js'
import { loadPrompt } from '../desks.js'
import { pgSink } from '../repo/model-calls.js'
import { estimateBatchMicros, estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { SEATS } from '../seats.js'

/**
 * `import.meta.url`, never `__dirname`: this package is `"type": "module"` with
 * NodeNext resolution, where `__dirname` is undefined. The prompt is a file, so
 * the version points at something a person reviews and a prompt change is a
 * reviewable diff. There is no build step here, tsx and vitest only, so the
 * relative URL resolves against the source tree at run time.
 *
 * Read through `loadPrompt`, the same loader `loadDesk` uses, and not with a
 * bare `readFileSync`. That strips every `<!-- ... -->` before the bytes are
 * sent and hashes what was sent: the `<!-- scout -->` marker and the sentinel
 * line are for us, neither is an instruction, and the sentinel in particular is
 * a string that must never appear in anything we deploy, least of all in a
 * prompt a model could repeat into a reply.
 *
 * Exported so `test/scout.test.ts` can assert what is actually SENT rather than
 * what is on disk, which is the only place that distinction can be checked.
 */
const { prompt: SYSTEM, promptVersion: VERSION } =
  loadPrompt(new URL('./prompts/scout.md', import.meta.url), '<!-- scout -->')
export { SYSTEM as SCOUT_PROMPT }

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
 * plan from two cities. The reservation for a failed call is refunded in full
 * only when an error BODY came back, on the same rule the driver uses
 * (`isUnbilled`, src/errors.ts): an error body carries no usage, so nothing was
 * billed. A connection failure, a timeout with no response at all or our own
 * abort keeps the debit, because the provider may have generated and billed a
 * response we never saw.
 *
 * That refund is not a rounding error at this size. `withRetry` (src/retry.ts)
 * wraps the whole agent step, so one step against a 503-ing provider reserves
 * the batch three times; `readSpendFailClosed` (src/limits.ts) sums
 * course.daily_usage across EVERY user for the global ceiling, so a fan-out
 * that stranded its batch would cap the product for the rest of the UTC day
 * with no lever short of a manual write.
 *
 * ## What a failed `reconcile` leaves behind, and what survives it
 *
 * `reconcile` is the one write in the per-scout body that moves money, and it
 * does not swallow its own failure. It is caught here rather than allowed to
 * end the call, and the split is the point.
 *
 * STRANDED: this scout's refund, `perCall` minus what the call really cost,
 * left debited against course.conversations and course.daily_usage until
 * somebody writes it back by hand. SURVIVING: the brief itself, which the model
 * wrote and we have already paid for; the `course.model_calls` row, which is
 * written after and carries the real figure; and `costMicros` on the returned
 * result, which reports what the call actually cost rather than `0n`.
 *
 * Without the catch, one failed bookkeeping write corrupted three different
 * answers at once. It stranded the share, it skipped `pgSink` so the call was
 * invisible to every cost query and to lesson 5.7's monitor, and it handed the
 * driver "No brief for Lisbon: the scout call failed" with `costMicros: 0n`
 * for a brief that existed and was billed.
 *
 * This is the driver's own asymmetry ("a row that describes what happened may
 * be lost, a row that decides what may happen next may not") read one notch
 * further rather than ignored. The row that DECIDES here is `reserve`'s, and it
 * landed before any call left. What is lost is a refund, and losing a refund
 * fails closed: the ceiling then counts more spend than really happened, never
 * less.
 *
 * ## What a kill mid-batch leaves behind
 *
 * Everything between `reserve` and the last `reconcile`, which is up to the
 * whole `n x perCall`. Nothing sweeps a reservation: `failTurn`,
 * `releaseForContinuation` and the sweeper all move turn state and not spend.
 * That is the driver's existing exposure multiplied by `n`, and the fan-out is
 * the longest single wait in a step, so tier 3's fifteen-minute kill is a
 * realistic trigger for this path specifically. Accepted rather than closed,
 * and written down in README's residuals with an owner, because closing it
 * needs a reservation somebody can sweep and this branch stores reservations in
 * two counters rather than in rows.
 */
export async function runScouts(deps: ScoutDeps, briefs: ScoutBrief[]): Promise<ScoutResult[]> {
  const { sql } = deps
  // BEFORE any arithmetic, because none of it survives an empty list:
  // `batchInputTokens` is `Math.max(...[])`, which is -Infinity, and
  // `estimateMicros` hands that to `BigInt(Math.ceil(...))`, which throws a
  // RangeError naming NaN before `estimateBatchMicros`'s own `n < 1` guard is
  // reached at all. The message is that guard's, because this is the same
  // fault: a caller that computed `n` from a list with nothing in it.
  //
  // `cities: z.array(...).min(1)` in the registry makes this unreachable
  // through the door, so what it protects is a direct caller of this exported
  // function.
  if (briefs.length === 0) throw new Error('runScouts: a batch needs at least 1 brief, got 0')
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
     * the parent can name which city said what.
     *
     * The parent's id is the driver's POSITIONAL ledger id, `s${step}-b${index}`
     * (src/agents/driver.ts mints it and passes exactly it into `deps.run`), and
     * never the provider's `toolu_` id, which rides on the `AgentStep` for the
     * transcript and never enters the runner chain. In production these read
     * `s3-b0-scout0`.
     *
     * That is also what makes them stable across a resume, and the reason is the
     * opposite of the obvious one. A provider mints a FRESH `toolu_` id every
     * time it answers, including its answer to a re-ask of the identical
     * transcript, so ids derived from one would differ on every attempt. The
     * step number and the block index do not move, so these do not either.
     */
    const callId = `${deps.callId}-scout${i}`
    let result: ModelResult
    try {
      result = await callModel(deps.client, argsFor(brief), deps.now)
    } catch (err) {
      // The driver's shape, on the driver's rule. Without this catch a
      // thrown call skipped the `reconcile` below entirely and this scout's
      // share of the batch stayed debited for ever, which is the leak the
      // docstring above describes and `test/scout.test.ts`'s 503 case reads off
      // both counters.
      if (isUnbilled(err)) {
        await reconcile(sql, {
          userId: deps.userId, conversationId: deps.conversationId,
          reserved: perCall, actual: 0n, day,
        })
      }
      throw err
    }
    const actual = result.kind === 'refused'
      ? 0n
      : costMicros(SEATS.scout.model, result.usage)
    // Caught, not propagated: the model has answered and been billed, and a
    // failed refund must not throw that brief away along with the row that
    // records it. What this leaves stranded, and what still stands, is in the
    // docstring above.
    try {
      await reconcile(sql, {
        userId: deps.userId, conversationId: deps.conversationId,
        reserved: perCall, actual, day,
      })
    } catch (err) {
      console.error(
        `runScouts: reconcile failed for ${callId} (${brief.city}); `
        + `${perCall - actual} micros stay reserved against this conversation and this day`,
        err,
      )
    }
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
