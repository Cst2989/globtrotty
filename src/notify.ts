export type EscalationReason = 'supplier_unavailable' | 'price_moved' | 'user_request' | 'safety' | 'cannot_satisfy'
export const ESCALATION_REASONS: readonly EscalationReason[] =
  ['supplier_unavailable', 'price_moved', 'user_request', 'safety', 'cannot_satisfy']
export type Escalation = {
  id: string; conversationId: string; userId: string; turnId: string | null
  proposalId: string | null; reason: EscalationReason; createdAt: Date
}
/**
 * The human desk's inbox, as a port. Spec section 3 says email; nothing is
 * deployed and no provider is configured, so the only implementation logs.
 * A real adapter is one file and no change to callers (plan 3b ruling).
 * Implementations must never throw on a malformed escalation — the row is
 * already committed by the time this runs, and the caller swallows anyway.
 */
export interface Notifier { notify(e: Escalation): Promise<void> }
export class LogNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void = (l) => console.error(l)) {}
  async notify(e: Escalation): Promise<void> {
    this.log(`ESCALATION ${e.id} reason=${e.reason} conversation=${e.conversationId} proposal=${e.proposalId ?? '-'} at=${e.createdAt.toISOString()}`)
  }
}
