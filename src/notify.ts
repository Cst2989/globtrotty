export type EscalationReason = 'supplier_unavailable' | 'price_moved' | 'user_request' | 'safety' | 'cannot_satisfy'
export const ESCALATION_REASONS: readonly EscalationReason[] =
  ['supplier_unavailable', 'price_moved', 'user_request', 'safety', 'cannot_satisfy']
export type Escalation = {
  id: string; conversationId: string; userId: string; turnId: string | null
  proposalId: string | null; reason: EscalationReason; createdAt: Date
}
/**
 * Plan 3c: the drift monitor's alarm, the second thing this port carries.
 * `check` is `'canary'` (a fingerprint changed against the seat's previous
 * run) or `'shape'` (the newest real request shape no longer matches what
 * `buildRequest` sends today). `detail` is a small jsonb blob describing the
 * diff — never a full request/response, which the alarm exists to flag, not
 * duplicate.
 */
export type DriftAlarm = {
  id: string; seat: string; check: 'canary' | 'shape'; detail: Record<string, unknown>; createdAt: Date
}

/**
 * The human desk's inbox, as a port. Spec section 3 says email; nothing is
 * deployed and no provider is configured, so the only implementation logs.
 * A real adapter is one file and no change to callers (plan 3b ruling).
 * Implementations must never throw on a malformed escalation — the row is
 * already committed by the time this runs, and the caller swallows anyway.
 *
 * `alarm` carries the same contract for the drift monitor (plan 3c, spec
 * section 4): best-effort, swallowed by the caller, never the thing that
 * fails a monitor run.
 */
export interface Notifier {
  notify(e: Escalation): Promise<void>
  alarm(a: DriftAlarm): Promise<void>
}
export class LogNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void = (l) => console.error(l)) {}
  async notify(e: Escalation): Promise<void> {
    this.log(`ESCALATION ${e.id} reason=${e.reason} conversation=${e.conversationId} proposal=${e.proposalId ?? '-'} at=${e.createdAt.toISOString()}`)
  }
  async alarm(a: DriftAlarm): Promise<void> {
    this.log(`DRIFT ${a.id} seat=${a.seat} check=${a.check} at=${a.createdAt.toISOString()}`)
  }
}
