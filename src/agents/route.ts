import type { Agent, AgentContext, AgentStep } from '../worker.js'
import { makeDriver } from './driver.js'
import { makeIntake, type IntakeDeps } from './intake.js'
import { readDesk } from '../repo/conversations.js'

/**
 * Plan 5, Task 5: intake replaces the Haiku front desk at `desk = 'front'` — it answers her
 * first message with a brief or a choice card rather than just recognising a trip request, and
 * (ledger ruling) flips the desk to 'planning' at the end of every run of its own, brief or
 * choices. So unlike the old front desk, intake never returns a `continue` step for THIS same
 * `routeAgent` call to fall through to the driver — `desk` is read once per step, same as
 * before, and a turn that needs both intake's work and the driver's own now takes two turns, not
 * one.
 *
 * Task 6 adds the real router here, for a choice-click action that must re-run intake on her
 * original message rather than dispatch on `desk` at all; until then this is the whole fleet.
 */
export function routeAgent(deps: IntakeDeps): Agent {
  const intake = makeIntake(deps)
  const driver = makeDriver(deps)
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const desk = await readDesk(deps.sql, ctx.conversationId, ctx.userId)
    return desk === 'front' ? intake(ctx) : driver(ctx)
  }
}
