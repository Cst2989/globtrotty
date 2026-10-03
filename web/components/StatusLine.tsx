export type StatusLineProps = {
  status: string
  failReason: string | null
}

/**
 * `conversations.status` (supabase/migrations/0001_harness.sql) → plain
 * words. `sending` (Task 10) is not a real stored status: `ThreadView`
 * substitutes it in while an optimistic message is in flight and the real
 * status has not yet flipped to `working`, so she sees "Sending" then
 * "Thinking" instead of the stale "Ready for your next message" the server
 * still reports for that instant.
 */
const STATUS_WORDS: Record<string, string> = {
  active: 'Ready for your next message',
  sending: 'Sending',
  working: 'Thinking',
  awaiting_user: 'Waiting for your reply',
  limit_reached: "Today's limit has been reached",
  escalated: 'A person from the office is looking at this',
  failed: 'Something went wrong',
  archived: 'Archived',
}

/** `turns.fail_reason` (same migration) → plain words, only shown when `status` is `failed`. */
const FAIL_REASON_WORDS: Record<string, string> = {
  provider_down: 'a travel provider was unavailable',
  fetch_failed: 'a search failed',
  limit_reached: "today's limit was reached mid-turn",
  step_cap: 'the turn ran too many steps',
  deadline_exceeded: 'the turn took too long',
  crash_loop: 'the agent kept failing the same way',
  fenced: 'the agent was stopped for safety reasons',
  stalled: 'the agent stopped responding',
}

/** Colour tone for the line; the CSS keys on `data-tone`. */
function toneFor(status: string): 'working' | 'failed' | 'limit' | 'neutral' {
  if (status === 'working' || status === 'sending') return 'working'
  if (status === 'failed') return 'failed'
  if (status === 'limit_reached' || status === 'escalated') return 'limit'
  return 'neutral'
}

/**
 * Maps `conversations.status` + the latest turn's `fail_reason` to plain
 * words for the traveller, never the raw codes. An unrecognised code (a
 * future status this component hasn't been taught yet) falls back to the
 * code itself rather than hiding the state silently. While `working`, the
 * words are followed by the three-dot thinking indicator every chat product
 * uses for "the other side is typing".
 */
export function StatusLine({ status, failReason }: StatusLineProps) {
  const words = STATUS_WORDS[status] ?? status
  const detail = status === 'failed' && failReason ? (FAIL_REASON_WORDS[failReason] ?? failReason) : null

  return (
    <p className="status-line" role="status" data-tone={toneFor(status)}>
      <span>
        {words}
        {detail ? `: ${detail}.` : ''}
      </span>
      {status === 'working' || status === 'sending' ? (
        <span className="thinking" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </p>
  )
}
