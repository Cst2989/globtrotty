import { describe } from 'vitest'

/**
 * The two live supplier files, and nothing else in the suite, touch the
 * network. They are declared with this, the same way every database test is
 * declared with `describeDb` (test/helpers/db.ts): one place reads the flag, so
 * `LIVE_SUPPLIERS` cannot come to mean two slightly different things in two
 * files.
 *
 * A fixture proves the parser. It cannot prove the endpoint still speaks the
 * shape the parser expects, and that is the only thing these files are for.
 */
export const describeLive = process.env.LIVE_SUPPLIERS === '1' ? describe : describe.skip

/**
 * The SearchApi key, read inside a test and never at module scope.
 *
 * This MUST be called from inside each `it`, never from the `describe`
 * callback. Vitest runs a suite's factory during COLLECTION even when the suite
 * is `describe.skip`, in order to enumerate its cases for the skip report, so a
 * throw in a describe body fires unconditionally, including on the offline
 * default run, and breaks `npm test` on every machine whose environment lacks
 * GOOGLE_SEARCH_API. Nothing that can throw may sit in a describe callback.
 */
export function requireSearchApiKey(): string {
  const apiKey = process.env.GOOGLE_SEARCH_API
  if (!apiKey) throw new Error('LIVE_SUPPLIERS=1 requires GOOGLE_SEARCH_API to be set')
  return apiKey
}
