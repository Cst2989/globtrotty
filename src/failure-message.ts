/**
 * What she reads when a turn ends without an answer for a reason that is ours,
 * not hers. One sentence, in one place, for the same reason the capped sentences
 * live in one place (src/limit-message.ts): the sweeper writes it when it reaps a
 * crash loop, and lesson 3.7 makes the worker loop's crash handler write the
 * same one, so a failure looks the same to her wherever it was noticed.
 *
 * It says what happened and what to do, and it does not apologise on behalf of a
 * system she cannot see. It also says the money part, because a turn that
 * stopped part way did spend something and she should not have to wonder.
 */
export const TURN_FAILED_MESSAGE =
  'Something went wrong on our side and this request did not finish. ' +
  'You have not been charged for anything beyond what it had already done. ' +
  'Please send it again.'
