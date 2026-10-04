const GENERIC_ERROR = 'That could not be sent. Please try again.'
const BUSY_ERROR = 'The desk is already working on this trip. Give it a moment.'
/**
 * A 429 from decide/revise is the spend ceiling: `submitAction` returns `limit_reached` BEFORE
 * its transaction, so nothing was written, and "please try again" would be advice that cannot
 * work today. Unlike the message box's 429 copy this never says "saved": the card stored nothing.
 */
const LIMIT_ERROR = "Today's spending limit is reached. The desk will pick this up tomorrow."

/**
 * A card's error copy for a non-OK response, a pure function so the status-to-copy mapping is
 * testable without a fetch mock.
 *
 * Its own module since the trip-stage pass: it was exported from the chat's proposal card, which
 * the results pane then imported for its own errors — the pane importing a chat component for one
 * string. Both import this instead.
 */
export function errorForStatus(status: number): string {
  if (status === 409) return BUSY_ERROR
  if (status === 429) return LIMIT_ERROR
  return GENERIC_ERROR
}
