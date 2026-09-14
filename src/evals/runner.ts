import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
import { TODAY } from '../conversation.js'
import type { Limits } from '../engine.js'
import { mockSuppliers } from '../supplier/mock.js'
import type { GoldenCase, Persona } from './cases.js'
import { latestProposal, sendReply, startEvalConversation, type EvalConversation, type EvalDeps } from './conversation.js'
import { gradeOutput, gradeTrajectory, type Grade, type Trace, type TraceCall } from './grade.js'
import { replayGates } from './replay.js'
import type { SimUser } from './sim-user.js'

export type CaseDeps = {
  sql: postgres.Sql
  client: ModelClient
  limits: Limits
  simUser: (persona: Persona) => SimUser
}

export type CaseResult = {
  caseId: string
  userId: string
  conversationId: string
  proposalId: string | null
  replies: string[]
  trace: Trace
  grades: Grade[]
}

/**
 * The ceiling on a conversation, so a case that never converges ends rather
 * than running until the spend cap stops it. P3's own loop uses fifteen.
 */
export const MAX_EVAL_TURNS = 15

/**
 * Every tool the frontier model asked for, read off the rows that record what it
 * answered.
 *
 * The source is `course.model_calls.response`, and the two obvious alternatives
 * are both blind to the same tool, which is the one the trajectory checks exist
 * to count.
 *
 * - `course.tool_calls` is written only by `ledgerRunner` (src/tools.ts), and
 *   this chain drops it exactly as `scripts/trip.ts` does, so it holds nothing
 *   at all for an eval run.
 * - `course.turns.state` is the transcript, and a VALID `ask_user` never reaches
 *   it. The driver returns `{ kind: 'message' }` for one (src/agents/driver.ts),
 *   and `src/worker.ts`'s message branch completes the turn and returns BEFORE
 *   the transcript append at the bottom of its loop, saying so in its own
 *   comment. What the transcript therefore holds is every `ask_user` the SCHEMA
 *   REFUSED and none of the ones that were asked, which does not read as zero,
 *   it reads as a plausible small integer that looks like a verdict. The first
 *   round of this lesson shipped exactly that: eleven questions counted as one.
 *
 * `pgSink` writes `response: { stop_reason, content }` from the driver on every
 * call it makes, before the driver has looked at what the model asked for
 * (src/agents/driver.ts), so every `tool_use` block is there whatever happened
 * to it afterwards: executed, refused by the schema, or refused by the supplier
 * budget. Scoped to `seat = 'driver'` because that is the frontier model this
 * check is about: the front desk publishes no tools and a scout answers in
 * prose.
 *
 * `callId` is the provider's own id off the block rather than the ledger's
 * positional key, because this trace identifies a call inside itself and has no
 * ledger row to join to. Lesson 6.5 replaces the whole of this with `loadTrace`,
 * which reads the corpus beside the calls.
 */
async function callsOf(sql: postgres.Sql, turnIds: string[]): Promise<TraceCall[]> {
  if (turnIds.length === 0) return []
  // Ordered by `seq`, the identity column every reader of this table sorts by,
  // and never by created_at: every row of one transaction shares that value.
  const rows = await sql<{ response: { content?: unknown } | null }[]>`
    select response from course.model_calls
     where turn_id = any(${turnIds}) and seat = 'driver'
     order by seq`
  const calls: TraceCall[] = []
  for (const row of rows) {
    const content = row.response?.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: string; name?: string; id?: string }[]) {
      if (block.type === 'tool_use' && block.name) {
        calls.push({ name: block.name, callId: block.id ?? '' })
      }
    }
  }
  return calls
}


/** Whether she has refused the same thing twice. */
function saidNoTwice(refused: readonly string[]): boolean {
  return new Set(refused).size < refused.length
}

/**
 * One case, driven end to end, graded.
 *
 * The user id is minted per case and never reused, so one case's spend cannot
 * exhaust another's and the gate metrics for a run are that run's. Lesson 6.4
 * gives that the rest of its reason, when an eval starts meeting a ceiling.
 */
export async function runCase(deps: CaseDeps, kase: GoldenCase): Promise<CaseResult> {
  const userId = randomUUID()
  const evalDeps: EvalDeps = {
    sql: deps.sql, client: deps.client, suppliers: mockSuppliers(),
    limits: deps.limits, today: TODAY, now: () => new Date(),
  }
  const her = deps.simUser(kase.persona)
  let convo: EvalConversation = await startEvalConversation(evalDeps, userId, kase.firstMessage)
  let proposalId = await latestProposal(evalDeps, convo)

  while (proposalId === null && her.turns < MAX_EVAL_TURNS) {
    const last = convo.replies.at(-1)
    if (last === undefined) break
    convo = await sendReply(evalDeps, convo, await her.reply(last))
    proposalId = await latestProposal(evalDeps, convo)
    // A case that is going in circles ends here rather than at MAX_EVAL_TURNS.
    // Twice is the threshold because once is a desk checking, and twice is a
    // desk that has been told: `no-for-1500-03` reaches this after the planning
    // desk has asked her to shorten a 28-night stay, been told no, asked her to
    // raise her budget, been told no, and asked her to shorten it again. Nothing
    // in the seven further turns it would otherwise run is new, and lesson 6.4
    // is about what those turns cost. A persona with no `refuses` can never
    // reach it, so the two cases that converge are unaffected.
    if (saidNoTwice(her.refused)) break
  }

  // The trace lesson 6.1 defined, assembled from what this run wrote. Lesson
  // 6.5 replaces this block with `loadTrace`, which reads the corpus and the
  // model calls as well and is what the two unreached trajectory checks need.
  const trace: Trace = {
    calls: await callsOf(deps.sql, convo.turnIds),
    replies: convo.replies,
  }

  // The WHOLE ReplayResult is kept, not its `outcome`. `gradeOutput` reads
  // `verdicts` and nothing else (src/evals/grade.ts, lesson 6.2's fix round),
  // because a `GateOutcome` cannot tell a budget gate that passed from a budget
  // gate that recorded null: both are simply absent from `violations`. The
  // items still come off the outcome, because the outcome is where they are.
  const replayed = proposalId === null
    ? undefined
    : await replayGates(evalDeps.sql, {
        proposalId, conversationId: convo.conversationId, userId,
        now: evalDeps.now(), today: evalDeps.today,
      })

  const reply = convo.replies.join('\n')
  const items = replayed?.outcome.ok ? replayed.outcome.items : []
  return {
    caseId: kase.id, userId, conversationId: convo.conversationId, proposalId,
    replies: convo.replies, trace,
    grades: [
      gradeOutput(reply, items, {
        budget: null, currency: 'EUR', mustInclude: kase.expect.mustInclude, window: null,
      }, replayed),
      gradeTrajectory(trace, {
        minFrontierCalls: kase.expect.minFrontierCalls,
        maxFrontierCalls: kase.expect.maxFrontierCalls,
        maxQuestionsAsked: kase.expect.maxQuestionsAsked,
      }),
    ],
  }
}
