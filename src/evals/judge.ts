import type postgres from 'postgres'
import { z } from 'zod'
import type { ModelClient } from '../client.js'
import { loadPrompt } from '../desks.js'
import { textOfBlocks, whichCeiling, type Limits } from '../engine.js'
import { isUnbilled } from '../errors.js'
import type { GateOutcome } from '../gates/types.js'
import { callModel, estimateInputTokens, type CallArgs } from '../model/client.js'
import { formatMoney } from '../money.js'
import { costMicros } from '../pricing.js'
import { pgSink, type TurnContext } from '../repo/model-calls.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { readSpendFailClosed } from '../repo/spend.js'
import { SEATS } from '../seats.js'

export const VerdictSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail']),
  // One sentence. Bounded, because a reason that runs to a paragraph is a
  // rating wearing a verdict's clothes, and the seat's 1,024 tokens are there
  // to make that hard rather than to make it impossible.
  //
  // The model is TOLD this number. The rubric file asks for "one sentence of at
  // most 300 characters" in the same breath as it asks for JSON, because a
  // bound only the parser knows about is a bound that silently drops a verdict
  // the model had no way to keep: `parseVerdict` returns null above it, and a
  // null is dropped from the numerator and the denominator both.
  reason: z.string().min(1).max(300),
})
export type Verdict = z.infer<typeof VerdictSchema>

/**
 * The reply, parsed rather than trusted.
 *
 * Returns null instead of throwing, because a judge that could not be read is
 * not a failing itinerary: it is a check that did not reach a verdict, and the
 * scorecard files it as not evaluated. Throwing here would turn an unreadable
 * reply into a fail and quietly move the pass rate every time the model
 * wrapped its JSON in prose.
 *
 * The fenced-code strip is narrow ON PURPOSE and its scope is worth stating
 * exactly, because the obvious reading of it is wrong. It removes a fence that
 * OPENS the trimmed reply and one that CLOSES it, and nothing else. A reply
 * that says a sentence and then fences the JSON does not parse, and neither
 * does one that fences it and then adds a closing remark: both return null and
 * are counted as unread. Widening it to hunt the first `{` through the matching
 * last `}` would parse those two, and it would also parse a brace inside a
 * sentence the model wrote about an itinerary, which is a verdict assembled by
 * this function rather than reported by the model. The narrow strip covers the
 * one shape a model asked for JSON actually returns often, a bare object or a
 * bare fenced block, and everything past that is a reply the rubric should be
 * fixed for rather than a reply this parser should guess at.
 */
export function parseVerdict(text: string): Verdict | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(stripped))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const PROMPT_FILE = new URL('./prompts/family-fit.md', import.meta.url)

/** The rubric, through the one loader prompts are loaded with: comments out, version over the bytes sent. */
export function loadJudgePrompt(): { prompt: string; promptVersion: string } {
  return loadPrompt(PROMPT_FILE, '<!-- judge: family-fit -->')
}

export type JudgeDeps = {
  sql: postgres.Sql
  client: ModelClient
  ctx: TurnContext
  /**
   * The ceilings this pass runs under, which are `EVAL_LIMITS` (src/limits.ts)
   * and never production's. Required and never defaulted, for the reason
   * `CaseDeps.seed` is: a default here would be one call site quietly grading
   * against her ceilings.
   */
  limits: Limits
  now: () => number
}

/**
 * The context a judge call is recorded under, and the ONE place its attribution
 * is decided.
 *
 * `turnId` is null, and it is null rather than the proposal's turn id. The rule
 * is `TurnContext`'s own (src/repo/model-calls.ts): both ids are null when a
 * call runs outside a turn, and this call does. The judge runs offline, on a
 * cron, hours or days after the turn that produced the proposal ended. The
 * consequence of getting it wrong is arithmetic rather than taste:
 * `turnSpendMicros` (src/repo/spend.ts) sums `course.model_calls.cost_micros`
 * for a turn with NO seat filter and `runMonitor` (src/monitor.ts) reads it, so
 * a judge row carrying her turn id would add an offline grader's bill to what
 * her turn is recorded as having cost, in a module whose whole thesis is that
 * every number carries an honest denominator.
 *
 * The conversation is the JUDGE PASS's own and not the proposal's, for the same
 * reason and one more. `runJudge` reserves and reconciles against
 * `ctx.conversationId`, so pointing it at hers would move her conversation's
 * `spend_usd_micros` for a call she did not make, and `EVAL_LIMITS`' tighter
 * ceilings would then be applied to her conversation rather than to the eval.
 * Every eval conversation on this branch mints its own `randomUUID()` user for
 * exactly that reason (src/limits.ts), and the judge pass is one more of them.
 * What is given up by that choice is the link from a judge row back to the
 * proposal it judged, which `course.model_calls` has no column for: the mapping
 * lives on the scorecard, in the `proposalId` each `Labelled` carries.
 */
export function judgeContext(run: { userId: string; conversationId: string }): TurnContext {
  return { userId: run.userId, conversationId: run.conversationId, turnId: null }
}

/**
 * The judge pass reached one of `EVAL_LIMITS`' ceilings.
 *
 * Thrown rather than returned as a null verdict, because those are different
 * facts and only one of them means stop. A null is one proposal the judge could
 * not read and the pass carries on. A reached ceiling is the pass being over,
 * and a caller that treated it as a null would reserve, refuse and refund once
 * for every proposal still in the list.
 */
export class JudgeCappedError extends Error {
  constructor(readonly ceiling: 'account' | 'conversation' | 'daily') {
    super(`The judge pass reached its ${ceiling} ceiling and stopped.`)
    this.name = 'JudgeCappedError'
  }
}

/**
 * What the judge is shown: the server's own rehydrated items, never the model's
 * words about them.
 *
 * ## What this payload can and cannot decide, read before editing the rubric
 *
 * One line per item, `slot: name (supplier, money) {the item's own detail as
 * JSON}`, under the total. So the rubric may only name properties that detail
 * carries. `FlightDetail` (src/supplier/types.ts) carries `outbound` and
 * `inbound` as `LegSummary`, which is where `stops`, `route`, `departureLocal`,
 * `arrivalLocal`, `cabinClass` and the carriers live, plus `baggage`,
 * `totalDurationSeconds` and `selfTransfer`. `HotelDetail` carries `checkIn`,
 * `checkOut`, `nights`, `rating`, `coordinates` and `offerSource`.
 *
 * What it does NOT carry is every prose field a rubric about family fit reaches
 * for first: there is no address, no neighbourhood, no description, no
 * atmosphere, no amenity list and no cot or crib anywhere in a `SupplierItem`.
 * The first draft of family-fit.md failed a stay "beside a motorway" and one
 * that "advertises a party atmosphere", and three of its four rules could
 * therefore never fire on any payload this function can produce. A rubric whose
 * rules cannot fire is a judge that always passes, which is the one failure
 * mode an unread rate hides best, so the rules were rewritten against the
 * fields above. A fifth field is a change to the supplier types and to what
 * `course.tool_results` stores, and README.md carries it as a residual.
 */
function render(outcome: GateOutcome): string {
  if (!outcome.ok) return ''
  const lines = outcome.items.map((i) =>
    `${i.ref.slot}: ${i.item.name} (${i.item.supplier}, ${formatMoney(i.lineTotal)})`
    + ` ${JSON.stringify(i.item.detail)}`)
  return [`total ${formatMoney(outcome.total)}`, ...lines].join('\n')
}

/**
 * One judged proposal, priced and BOUNDED like every other model call this
 * branch makes.
 *
 * A rejected outcome is never judged and never billed. The rubric's own first
 * paragraph says price, dates, provenance and currency are decided by code
 * before the judge sees anything, so an itinerary the gates refused is one the
 * judge has no question to answer about.
 *
 * ## The ledger
 *
 * There is no fifth writer. This reserves through `reserve` and settles through
 * `reconcile` (src/repo/reservation.ts), the third and fourth of the four
 * functions that move `course.conversations.spend_usd_micros` and
 * `course.daily_usage.cost_micros`, exactly as `makeDriver` does, and the row
 * goes through `pgSink`, which touches no money. The first draft of this
 * function reserved nothing, and the consequence was that a nightly pass of up
 * to a hundred model calls was bounded by nothing but its own `limit`: no
 * conversation ceiling, no daily ceiling and no global ceiling was in the path,
 * which made `src/limits.ts`'s claim that `globalCeilingMicros` "still bounds
 * the whole night" false for the one section of the night that was not a
 * conversation.
 *
 * All three are read, and the global one is read rather than assumed, which is
 * where this differs from `makeDriver`. The driver may pass `globalMicros: 0n`
 * because `decideNext` checked all three from `readSpendFailClosed` before the
 * agent was called. Nothing checks anything before a judge pass, so it reads
 * the spend itself after its own reservation has landed.
 */
export async function runJudge(deps: JudgeDeps, outcome: GateOutcome): Promise<Verdict | null> {
  if (!outcome.ok) return null
  const { prompt, promptVersion } = loadJudgePrompt()
  const args: CallArgs = {
    seat: SEATS.reviewer, system: prompt, tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: render(outcome) }] }],
  }

  const reserved = estimateMicros(SEATS.reviewer, estimateInputTokens(args))
  const { userId, conversationId } = deps.ctx
  if (conversationId === null) {
    throw new Error('runJudge: the judge pass needs a conversation of its own to bill against')
  }
  const { day } = await reserve(deps.sql, { userId, conversationId, micros: reserved })
  // Guarded, the way `makeDriver`'s refund is: every caller below is already on
  // a path that has decided what this call returns, and a failed bookkeeping
  // write must not replace a verdict or a classified error with a database one.
  // What is stranded is the refund, which fails closed: the ceiling then counts
  // more spend than happened, never less.
  const refund = async () => {
    try {
      await reconcile(deps.sql, { userId, conversationId, reserved, actual: 0n, day })
    } catch (err) {
      console.error(
        `runJudge: the refund for conversation ${conversationId} failed. `
        + `${reserved} micros stay reserved against it and against this day`, err,
      )
    }
  }

  // Read AFTER the reservation, so the numbers compared are the ones this call
  // has already moved rather than a reading from before it.
  const reached = whichCeiling(await readSpendFailClosed(deps.sql, userId, conversationId), deps.limits)
  if (reached !== null) {
    await refund()
    throw new JudgeCappedError(reached)
  }

  let result
  try {
    result = await callModel(deps.client, args, deps.now)
  } catch (err) {
    // `isUnbilled` (src/errors.ts) is the driver's own rule and is reused rather
    // than restated: an error BODY at any status carries no usage, so nothing
    // was billed and the whole reservation comes back. A connection failure or
    // a timeout with no response keeps the debit, because the provider may have
    // generated and billed a response we never saw.
    if (isUnbilled(err)) await refund()
    throw err
  }

  const actual = costMicros(SEATS.reviewer.model, result.usage, '5m')
  // The row first, because the row is the fact: it is written for a refusal as
  // well as for a verdict, so a refused judge call is still recorded and still
  // billed rather than disappearing from the ledger.
  await pgSink(deps.sql, deps.ctx)({
    seat: 'reviewer', seatConfig: SEATS.reviewer, promptVersion,
    modelRequested: SEATS.reviewer.model, modelReturned: result.model,
    usage: result.usage, costMicros: actual,
    latencyMs: result.latencyMs, requestId: result.requestId,
  })
  await reconcile(deps.sql, { userId, conversationId, reserved, actual, day })
  return result.kind === 'ok' ? parseVerdict(textOfBlocks(result.content)) : null
}

export type Labelled = { proposalId: string; decision: 'accept' | 'reject'; verdict: 'pass' | 'fail' }

/**
 * Below about eighty percent agreement the judge is measuring something users
 * do not care about, and the fix is the rubric rather than the users. P3's own
 * number, kept as a named constant so a scorecard reader can see what the
 * threshold is rather than inferring it from a comparison.
 */
export const AGREEMENT_FLOOR = 0.8

export type Agreement = { agreed: number; total: number; meetsFloor: boolean }

/**
 * How often the judge and she reached the same answer, with the denominator.
 *
 * Two values and not three. `course.proposals.decision` accepts 'accept' and
 * 'reject' (migration 0013) and nothing else, and the edit P3 calls the richest
 * signal in the system is module 7's subject rather than this lesson's: a third
 * value would be a column added for a reader that does not exist, which is the
 * exact defect 0013's own comment warns about. So `accept` is compared against
 * `pass` and `reject` against `fail`, and the constraint is not widened here.
 *
 * An empty table does not meet the floor. Zero of zero is not agreement, it is
 * a calibration nobody performed, and a judge deployed on the strength of it
 * would be a judge nobody checked.
 */
export function judgeAgreement(rows: Labelled[]): Agreement {
  const agreed = rows.filter((r) =>
    (r.decision === 'accept' && r.verdict === 'pass')
    || (r.decision === 'reject' && r.verdict === 'fail')).length
  return {
    agreed, total: rows.length,
    meetsFloor: rows.length > 0 && agreed / rows.length >= AGREEMENT_FLOOR,
  }
}
