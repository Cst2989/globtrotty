import { whichCeiling, type Limits, type Spend } from './engine.js'

/**
 * What she reads when a ceiling stops a turn before it runs. One sentence per
 * ceiling, so she knows which one and that nothing ran. Kept in one place so
 * tier 2's own denial (src/handler.ts) and tier 3's (src/loop.ts,
 * src/conversation.ts) say the same thing.
 */
export const LIMIT_REACHED_MESSAGE = {
  conversation: 'This conversation has reached its spending limit for now. This turn did not run.',
  daily: 'You have reached your daily spending limit. This turn did not run.',
  account: "Every traveller together has reached today's account limit. This turn did not run.",
} as const

/**
 * Picks the sentence above for a confirmed ceiling read. A read that could not
 * confirm anything at all (`readSpendOrLimitReached`'s sentinel, src/loop.ts)
 * denies the same way a reached ceiling does and cannot say which one, so it
 * gets the broadest sentence rather than a guess.
 */
export function limitReachedMessage(spend: Spend | 'limit_reached', limits: Limits): string {
  if (spend === 'limit_reached') return LIMIT_REACHED_MESSAGE.account
  return LIMIT_REACHED_MESSAGE[whichCeiling(spend, limits) ?? 'account']
}
