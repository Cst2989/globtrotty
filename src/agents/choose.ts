import type { AgentContext, AgentStep } from '../worker.js'
import type { IntakeDeps } from './intake.js'

/** The router's own shape for a `choose` action, matching Task 7's own documented interface —
 * the full `ActionPayload` carries `action: 'choose'` too, but that field has already done its
 * job (telling the router which handler to call) by the time it reaches this one. */
export type ChooseAction = { kind: 'flight' | 'hotel'; sourceId: string }

// Task 7 replaces this. Plan 5 Task 6 only wires the router's dispatch (src/agents/router.ts) so
// a `choose` action does not fall through to the driver, which has no tool for it — proposals,
// the hotel search after a flight choice and the pinned summary after a hotel choice all land
// with Task 7 (docs/superpowers/sdd/.../task-7-brief.md).
export async function handleChoose(
  _deps: IntakeDeps, _ctx: AgentContext, _action: ChooseAction,
): Promise<AgentStep> {
  return { kind: 'park', message: 'Noted.', costMicros: 0n }
}
