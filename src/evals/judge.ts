import type postgres from 'postgres'
import { z } from 'zod'
import type { ModelClient } from '../client.js'
import { loadPrompt } from '../desks.js'
import { textOfBlocks } from '../engine.js'
import type { GateOutcome } from '../gates/types.js'
import { callModel } from '../model/client.js'
import { formatMoney } from '../money.js'
import { costMicros } from '../pricing.js'
import { pgSink, type TurnContext } from '../repo/model-calls.js'
import { SEATS } from '../seats.js'

export const VerdictSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail']),
  // One sentence. Bounded, because a reason that runs to a paragraph is a
  // rating wearing a verdict's clothes, and the seat's 1,024 tokens are there
  // to make that hard rather than to make it impossible.
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
 * The fenced-code strip is the one tolerance, because a model asked for JSON
 * and given a markdown-shaped conversation returns a fenced block often enough
 * that refusing it would measure formatting rather than family fit.
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
  now: () => number
}

/** What the judge is shown: the server's own rehydrated items, never the model's words about them. */
function render(outcome: GateOutcome): string {
  if (!outcome.ok) return ''
  const lines = outcome.items.map((i) =>
    `${i.ref.slot}: ${i.item.name} (${i.item.supplier}, ${formatMoney(i.lineTotal)})`
    + ` ${JSON.stringify(i.item.detail)}`)
  return [`total ${formatMoney(outcome.total)}`, ...lines].join('\n')
}

/**
 * One judged proposal, priced like every other model call this branch makes.
 *
 * A rejected outcome is never judged and never billed. The rubric's own first
 * paragraph says price, dates, provenance and currency are decided by code
 * before the judge sees anything, so an itinerary the gates refused is one the
 * judge has no question to answer about.
 *
 * The row is written through `pgSink`, which touches no money: the four
 * functions that move `course.conversations.spend_usd_micros` and
 * `course.daily_usage.cost_micros` are `recordSpend`, `ledgerSink`, `reserve`
 * and `reconcile`, and this is not a fifth. The judge runs offline over
 * proposals that are already decided, so there is no conversation ceiling for
 * it to reserve against; what it costs is in `course.model_calls.cost_micros`
 * under `seat = 'reviewer'`, which is one `group by` away from the run it
 * belongs to.
 */
export async function runJudge(deps: JudgeDeps, outcome: GateOutcome): Promise<Verdict | null> {
  if (!outcome.ok) return null
  const { prompt, promptVersion } = loadJudgePrompt()
  const sink = pgSink(deps.sql, deps.ctx)
  const result = await callModel(deps.client, {
    seat: SEATS.reviewer, system: prompt, tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: render(outcome) }] }],
  }, deps.now)
  await sink({
    seat: 'reviewer', seatConfig: SEATS.reviewer, promptVersion,
    modelRequested: SEATS.reviewer.model, modelReturned: result.model,
    usage: result.usage, costMicros: costMicros(SEATS.reviewer.model, result.usage, '5m'),
    latencyMs: result.latencyMs,
  })
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
