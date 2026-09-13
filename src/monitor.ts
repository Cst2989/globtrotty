import type postgres from 'postgres'
import type { ModelClient } from './client.js'
import { textOfBlocks } from './engine.js'
import { callModel } from './model/client.js'
import { readFeed, type AgentEventKind } from './repo/agentEvents.js'
import type { TurnContext } from './repo/model-calls.js'
import { turnSpendMicros } from './repo/spend.js'
import { SEATS } from './seats.js'

/**
 * Everything a monitor could complain about, computed from rows. Pure, so the
 * assertions in test/monitor.test.ts are real assertions rather than a fixture
 * reply read back, and so the interesting half of this file needs no API key.
 */
export type TurnShape = {
  searches: number
  proposals: number
  toolsStarted: number
  toolsFinished: number
  escalated: boolean
  /**
   * What this turn's model calls cost, off `course.model_calls`
   * (`turnSpendMicros`). It is NOT what the turn debited: `reserve` and
   * `reconcile` move two counters and write no row here, so a reservation that
   * was never reconciled is money against her ceilings that this number does
   * not carry and this monitor cannot report. Seeing that needs a row per
   * reservation, which nothing in this branch writes; README.md names it with an
   * owner rather than leaving a reader to infer it from a field called spend.
   */
  spendMicros: bigint
}

export function shapeOfTurn(
  feed: { kind: AgentEventKind; detail: string | null }[], spendMicros: bigint,
): TurnShape {
  const started = feed.filter((e) => e.kind === 'tool_start')
  return {
    searches: started.filter((e) => e.detail?.startsWith('search_') ?? false).length,
    proposals: started.filter((e) => e.detail === 'propose_itinerary').length,
    toolsStarted: started.length,
    toolsFinished: feed.filter((e) => e.kind === 'tool_done').length,
    escalated: feed.some((e) => e.kind === 'escalated'),
    spendMicros,
  }
}

export type MonitorDeps = { sql: postgres.Sql; client: ModelClient; now: () => number }

/**
 * Inline rather than in `src/desks/`, and deliberately so: `loadDesk` and
 * `promptVersion` exist for the two prompts a traveller's turn is answered
 * with, and those are the two `npm run sentinels` greps. This prompt never
 * reaches her, carries no scope refusal and has no version she could be shown,
 * so giving it a file would put a third thing in a directory whose whole
 * meaning is "the desks".
 */
export const MONITOR_PROMPT =
  'You are given a JSON summary of one completed turn of a travel agency: how many '
  + 'tools it started and finished, how many searches, how many proposals, whether it '
  + 'escalated, and what it spent in USD micros. Say in one sentence whether anything '
  + 'about it looks wrong, and name the number that made you say so. If nothing does, '
  + 'say "nothing unusual". You are not deciding anything and nothing you say stops or '
  + 'changes a turn.'

/**
 * Watches what the agency did and says so. It alarms and it never blocks.
 *
 * Nothing here can fail a turn, and that is a rule rather than a coincidence. A
 * monitor with a veto is a second decision point on the money and correctness
 * path, running on a cheap seat, which is exactly the thing every gate in this
 * system was built to avoid: the gates are deterministic and this is not.
 *
 * It reads `course.agent_events` and `course.model_calls` for the turn and
 * writes what it found to the log. What makes it worth having is the class of
 * thing a deterministic check cannot name: a turn that searched six times and
 * proposed nothing, a turn whose briefs all say a listing contained an
 * instruction, a conversation whose spend is inside every ceiling and is four
 * times its neighbours.
 *
 * Everything it does is inside one try, including the two reads, because both
 * run before the model call and a read that propagated would take the turn with
 * it just as surely as a veto would.
 *
 * It logs, and this repository has nowhere to page. That is a residual and it is
 * named in README.md rather than left as a note in the code.
 */
export async function runMonitor(deps: MonitorDeps, ctx: TurnContext): Promise<void> {
  try {
    const shape = shapeOfTurn(
      await readFeed(deps.sql, ctx.conversationId!, ctx.userId),
      await turnSpendMicros(deps.sql, ctx.turnId!),
    )
    const result = await callModel(deps.client, {
      seat: SEATS.monitor,
      system: MONITOR_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(shape,
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) }] }],
      tools: [],
    }, deps.now)
    console.warn('monitor', { turnId: ctx.turnId, shape, note: textOfBlocks(
      result.kind === 'ok' ? result.content : []) })
  } catch (err) {
    // Swallowed, and never silently. A monitor that threw would be the veto it
    // is not allowed to have.
    console.error('runMonitor: skipped', { turnId: ctx.turnId, err })
  }
}
