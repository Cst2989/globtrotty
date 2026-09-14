import type { Agent, AgentContext, AgentStep } from '../worker.js'
import { makeDriver, type DriverDeps } from './driver.js'
import { makeFrontDesk } from './frontDesk.js'
import { readDesk } from '../repo/conversations.js'

/**
 * Parent spec section 3: the front desk sees the first message and "then never
 * appears again". The flag is `conversations.desk`, read on EVERY step rather
 * than once per turn, because the front desk flips it mid-turn and returns a
 * `continue` — the next step of the same turn must land on the driver.
 */
export function routeAgent(deps: DriverDeps): Agent {
  const front = makeFrontDesk(deps)
  const driver = makeDriver(deps)
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const desk = await readDesk(deps.sql, ctx.conversationId, ctx.userId)
    return desk === 'front' ? front(ctx) : driver(ctx)
  }
}
