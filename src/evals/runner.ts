import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
import { TODAY } from '../conversation.js'
import type { Limits, TurnState } from '../engine.js'
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
 * Every tool the frontier model asked for, read off the transcripts this case
 * persisted.
 *
 * The transcript and NOT `course.tool_calls`, which would be the obvious table
 * and is the wrong one twice over. `ledgerRunner` is the only writer of that
 * table (src/tools.ts) and this chain drops it, exactly as `scripts/trip.ts`
 * does, so it holds nothing at all for an eval run. And even on tier 3, where
 * the ledger runs, it would never hold an `ask_user`: that branch returns from
 * the driver before `deps.run` is called (src/agents/driver.ts), so the one tool
 * `questions_stayed_few` counts is the one tool the ledger cannot see.
 *
 * `course.turns.state` is what `completeTurn` writes at the end of every turn
 * (src/repo/turns.ts), and it is the model's own transcript, so every `tool_use`
 * block the model emitted is in it, `ask_user` included. `callId` here is the
 * provider's id off the block rather than the ledger's positional key, because
 * this trace identifies a call inside itself and has no ledger row to join to.
 * Lesson 6.5 replaces the whole of this with `loadTrace`, which reads the corpus
 * and the model calls beside the transcript.
 */
async function callsOf(sql: postgres.Sql, turnIds: string[]): Promise<TraceCall[]> {
  if (turnIds.length === 0) return []
  const rows = await sql<{ id: string; state: TurnState | null }[]>`
    select id, state from course.turns where id = any(${turnIds})`
  const byId = new Map(rows.map((r) => [r.id, r.state]))
  const calls: TraceCall[] = []
  // Walked in the order the case produced the turns, never in the order the
  // database happened to return them and never by created_at: every row of one
  // turn shares a transaction timestamp, so that column cannot order anything.
  for (const turnId of turnIds) {
    for (const message of byId.get(turnId)?.messages ?? []) {
      if (message.role !== 'assistant') continue
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.push({ name: block.name, callId: block.id })
      }
    }
  }
  return calls
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
