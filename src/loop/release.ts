import type { Desk } from '../tools/registry.js'

/** Which prompt a conversation was served. Two arms, because a comparison needs two. */
export type Variant = 'control' | 'candidate'

/**
 * Which arm one conversation is in.
 *
 * Hashed on the CONVERSATION id and never on a random number, and that is the
 * whole design. A turn is not a unit anybody experiences: she sends a message,
 * we plan, she revises, we propose again, and a coin flipped per turn would
 * give her a conversation whose turns ran two different prompts, which makes
 * the transcript incoherent to her and makes every conversion attributed to it
 * meaningless. Hashing the id also makes a RESUMED turn land in the arm it
 * started in, which a random number cannot, and a resumed turn is an ordinary
 * event on this branch (src/sweeper.ts).
 *
 * FNV-1a, the same hash `seedFor` uses (src/evals/variance.ts), for the same
 * reason it gives: it is four lines, it is deterministic across processes and
 * versions of Node, and it does not need a dependency. This is not a security
 * boundary and nothing about it needs to be unguessable.
 *
 * `rolloutPercent` is checked rather than clamped. A rollout of 150 is somebody
 * who meant something and a clamp would run it as 100 without saying so.
 */
export function assignVariant(conversationId: string, rolloutPercent: number): Variant {
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new Error(`Release rollout must be a whole percent from 0 to 100, got ${rolloutPercent}`)
  }
  if (rolloutPercent === 0) return 'control'
  if (rolloutPercent === 100) return 'candidate'
  let h = 0x811c9dc5
  for (const char of conversationId) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100 < rolloutPercent ? 'candidate' : 'control'
}

/**
 * The rollback switch, which is a constant in a file and not a row in a table.
 *
 * Rolling back is a commit and a deploy. That is the module's standing rule
 * (the loop writes data and proposes changes, a commit changes behaviour) and
 * here it has a second reason of its own: a rollout stored in a table can be
 * changed by anything that can write that table, including a turn, and the
 * thing it changes is which prompt a traveller is served. It also has to be
 * readable from a test with no database, because the assignment is the part of
 * this machine that has to be provable.
 *
 * Zero percent, shipped. The candidate exists, the assignment is tested at both
 * boundaries, and nobody is in the candidate arm, because this branch has no
 * traffic to split and a rollout above zero would be a number pretending
 * otherwise. Raising it is one line and a review.
 */
export const RELEASE: { desk: Desk; rolloutPercent: number } = {
  desk: 'planning',
  rolloutPercent: 0,
}

/** The one production call site's question, so no caller re-reads RELEASE itself. */
export function variantFor(conversationId: string): Variant {
  return assignVariant(conversationId, RELEASE.rolloutPercent)
}
