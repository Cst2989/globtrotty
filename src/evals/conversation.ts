import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { makeDriver, provenanceFor } from '../agents/driver.js'
import { cashierRunner } from '../cashier.js'
import type { ModelClient } from '../client.js'
import type { Limits } from '../engine.js'
import { constraintsFromNotebook } from '../gates/pipeline.js'
import { proposalRunner } from '../gates/runner.js'
import { submitMessage, type SubmitResult } from '../handler.js'
import { loadNotebook } from '../repo/notebook.js'
import type { SupplierPair } from '../supplier/types.js'
import {
  cardRunner, corpusRunner, doorRunner, escalationRunner, notebookRunner, scoutRunner,
  scoutStayFrom, supplierRunner, type ToolRunner,
} from '../tools.js'
import { runTurn, type AgentContext } from '../worker.js'

export type EvalDeps = {
  sql: postgres.Sql
  client: ModelClient
  suppliers: SupplierPair
  limits: Limits
  today: string
  now: () => Date
}

export type EvalConversation = {
  conversationId: string
  userId: string
  turnIds: string[]
  replies: string[]
}

/**
 * The runner chain the eval drives, assembled exactly as `scripts/trip.ts`
 * assembles it and for the same reason: one process, no crash to resume from,
 * so `ledgerRunner` is dropped and every other wrapper stays. That is nine
 * wrappers around nothing, door outermost and supplier innermost, against tier
 * 3's ten (netlify/functions/run-turn-background.mts). A chain missing a wrapper
 * advertises a tool and then answers "Unknown tool" out of the innermost link,
 * which is a failure no eval would attribute correctly, and
 * `test/desks.test.ts` fails a chain that loses one the planning desk publishes.
 *
 * Built per agent step, like tier 3's and like the script's, because the
 * notebook is read fresh every step and because `corpusRunner` fences its writes
 * on a claim whose `attempts` only the harness knows.
 */
async function chainFor(deps: EvalDeps, ctx: AgentContext): Promise<ToolRunner> {
  const claim = {
    turnId: ctx.turnId, conversationId: ctx.conversationId, userId: ctx.userId,
    attempts: ctx.attempts, state: ctx.state,
  }
  // The raw notebook is kept as well as the constraints, for the reason
  // `scripts/trip.ts` gives: the gates want the three fields
  // `constraintsFromNotebook` keeps, and a scouting search wants her nights and
  // her party size, which it drops.
  const nb = await loadNotebook(deps.sql, ctx.conversationId, ctx.userId)
  const notebook = constraintsFromNotebook(nb, deps.today)
  const gateCtx = {
    conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId,
  }
  return doorRunner('planning', notebookRunner(
    deps.sql,
    {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      // Derived from this step's transcript, the same way tier 3 and the script
      // derive it: a patch made before any search is her words and a patch made
      // after one is not.
      source: () => provenanceFor(ctx),
      now: deps.now,
    },
    scoutRunner(
      deps.sql,
      {
        client: deps.client, suppliers: deps.suppliers, stay: scoutStayFrom(nb, deps.today),
        conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId,
        limits: deps.limits, now: () => deps.now().getTime(),
      },
      cardRunner(
        deps.sql, gateCtx,
        escalationRunner(
          deps.sql, gateCtx,
          cashierRunner(
            deps.sql, gateCtx,
            { suppliers: deps.suppliers, limits: deps.limits, now: deps.now },
            proposalRunner(
              deps.sql,
              { ...gateCtx, notebook, snapshot: nb, now: deps.now },
              // The searches ask for the SAME currency the gates expect, off the
              // same constraints object, so a corpus and the currency gate
              // cannot disagree by construction.
              corpusRunner(deps.sql, claim, supplierRunner(deps.suppliers, notebook.currency)),
            ),
          ),
        ),
      ),
    ),
  ))
}

/** The in-process invoke: tier 2 hands the turn to tier 3 without an HTTP hop. */
function invokeInProcess(deps: EvalDeps, seen: string[]) {
  return async (turnId: string): Promise<void> => {
    seen.push(turnId)
    await runTurn({
      sql: deps.sql,
      limits: deps.limits,
      now: () => deps.now().getTime(),
      // A generous deadline, because an eval is not a ten second HTTP handler
      // and a case that parks for want of time is a case measuring the clock.
      deadlineMs: () => deps.now().getTime() + 120_000,
      reinvoke: invokeInProcess(deps, seen),
      agent: async (ctx) => makeDriver({
        sql: deps.sql, client: deps.client, limits: deps.limits,
        now: () => deps.now().getTime(),
        run: await chainFor(deps, ctx),
      })(ctx),
    }, turnId)
  }
}

async function repliesFor(deps: EvalDeps, convo: EvalConversation): Promise<string[]> {
  const rows = await deps.sql<{ content: string }[]>`
    select content from course.messages
     where conversation_id = ${convo.conversationId} and user_id = ${convo.userId}
       and role = 'agent'
     order by seq`
  return rows.map((r) => r.content)
}

/**
 * Refuses anything but `queued`.
 *
 * `submitMessage` answers `'queued' | 'duplicate' | 'limit_reached' | 'busy'`
 * (src/handler.ts) and three of those four mean NO TURN RAN. Swallowed, they are
 * worse than a crash: `repliesFor` returns the same list it returned last time,
 * the traveller answers the same text, the loop burns its fifteen turns, and
 * `no-for-1500-03` reaches no proposal and passes as "the agency correctly said
 * no" when what really happened is that a spend ceiling stopped it. Lesson 6.4
 * is the lesson about meeting ceilings, so this is the wrong place to absorb
 * one.
 *
 * A throw rather than a field on `EvalConversation`, because `evals/run.ts`
 * already has the machinery for a case that did not complete: it catches, names
 * the case, and leaves it in `casesExpected` and out of `casesGraded`, so the
 * denominator carries it and no rate improves by losing it.
 */
function mustBeQueued(status: SubmitResult['status'], conversationId: string): void {
  if (status === 'queued') return
  throw new Error(
    `The eval submitted a message to conversation ${conversationId} and got `
    + `'${status}' rather than 'queued', so no turn ran. A case cannot be graded on `
    + 'a conversation the handler refused.',
  )
}

export async function startEvalConversation(
  deps: EvalDeps, userId: string, firstMessage: string,
): Promise<EvalConversation> {
  const seen: string[] = []
  const submitted = await submitMessage(
    { sql: deps.sql, limits: deps.limits, invoke: invokeInProcess(deps, seen) },
    { userId, conversationId: null, message: firstMessage, idempotencyKey: randomUUID() },
  )
  mustBeQueued(submitted.status, submitted.conversationId)
  const convo = {
    conversationId: submitted.conversationId, userId, turnIds: [...seen], replies: [],
  }
  return { ...convo, replies: await repliesFor(deps, convo) }
}

export async function sendReply(
  deps: EvalDeps, convo: EvalConversation, text: string,
): Promise<EvalConversation> {
  const seen: string[] = []
  const submitted = await submitMessage(
    { sql: deps.sql, limits: deps.limits, invoke: invokeInProcess(deps, seen) },
    {
      userId: convo.userId, conversationId: convo.conversationId,
      message: text, idempotencyKey: randomUUID(),
    },
  )
  mustBeQueued(submitted.status, convo.conversationId)
  const next = { ...convo, turnIds: [...convo.turnIds, ...seen] }
  return { ...next, replies: await repliesFor(deps, next) }
}

/** The newest proposal this conversation produced, or null when it made none. */
export async function latestProposal(
  deps: EvalDeps, convo: EvalConversation,
): Promise<string | null> {
  const rows = await deps.sql<{ id: string }[]>`
    select id from course.proposals
     where conversation_id = ${convo.conversationId} and user_id = ${convo.userId}
     order by seq desc limit 1`
  return rows[0]?.id ?? null
}
