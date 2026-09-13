import type postgres from 'postgres'
import type { EscalationReason, Notifier } from '../notify.js'
import { MAX_ESCALATIONS_PER_DAY, countEscalationsToday, markNotified, recordEscalation } from '../repo/escalations.js'
import { loadProposal } from '../repo/proposals.js'
import { sanitizeSourceId } from '../sanitize.js'

/**
 * Fixed format in, one row out. The model chooses a reason from an enum and
 * optionally names a proposal; no free text reaches the row. The rate limit
 * is read fail-closed from the table. The notifier is best-effort and
 * swallowed, exactly like a span: the escalation exists once the row does.
 */
export async function escalate(
  deps: { sql: postgres.Sql; notifier: Notifier; now: () => number },
  ctx: { conversationId: string; userId: string; turnId: string },
  input: { reason: EscalationReason; proposalId?: string },
): Promise<string> {
  const now = new Date(deps.now())
  if (input.proposalId !== undefined && (await loadProposal(deps.sql, ctx.conversationId, input.proposalId)) === null) {
    return `No proposal ${sanitizeSourceId(input.proposalId)} in this conversation; escalate without a proposal id or use the right one.`
  }
  const used = await countEscalationsToday(deps.sql, ctx.userId, now)
  if (used >= MAX_ESCALATIONS_PER_DAY) {
    return `Escalation limit reached for today (${MAX_ESCALATIONS_PER_DAY}). Tell her a human will not be paged again today and offer what you can do yourself.`
  }
  const e = await recordEscalation(deps.sql, { conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId,
    proposalId: input.proposalId ?? null, reason: input.reason })
  try {
    await deps.notifier.notify(e)
    await markNotified(deps.sql, e.id)
  } catch (err) {
    console.error(`escalate: notifier failed for ${e.id}: ${(err as Error).message}`)
  }
  return `Escalated to a human (reason: ${input.reason}). Tell her someone will look at this and stop planning; do not promise a time.`
}
