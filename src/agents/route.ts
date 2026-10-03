import type { Agent, AgentContext, AgentStep } from '../worker.js'
import { makeIntake, type IntakeDeps } from './intake.js'
import { makeRouter } from './router.js'
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
 * Task 6: `desk === 'planning'` now reaches the Jev intent router (src/agents/router.ts), not
 * the driver directly — a card action dispatches on itself, a typed message gets classified by
 * one Jev call first (`filter`/`new_search`/`question`/`chat`/`faq`), and the router is what
 * calls the driver for `question`/`chat`/`hand_off`/`rejected`/`revise` today.
 */
export function routeAgent(deps: IntakeDeps): Agent {
  const intake = makeIntake(deps)
  const router = makeRouter(deps)
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const desk = await readDesk(deps.sql, ctx.conversationId, ctx.userId)
    return desk === 'front' ? intake(ctx) : router(ctx)
  }
}
