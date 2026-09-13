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
 * The same flag AND a key, for the one live file that needs one.
 *
 * Kiwi needs no key, which is the whole point of lesson 4.2's proof
 * (`LESSONS.md`), and `.env.example` says so: without `GOOGLE_SEARCH_API`,
 * `LIVE_SUPPLIERS=1 npm test` skips the SearchApi live file. It did not skip.
 * `describeLive` alone is `describe` the moment the flag is set, and the key
 * read inside each `it` threw, which is a FAILED test, so a reader with no
 * SearchApi account ran the checkpoint's own proof and got a red suite. The
 * half of it that needed no key never got looked at.
 *
 * Skipped WITH A PRINTED REASON, because a silent skip is the other way to
 * mislead the same reader: a run that says nothing looks like a run that
 * checked something. The line is written at module scope, once, and only in the
 * case it describes. Vitest's default reporter buffers console output on a
 * green run and prints none of it, so the line shows under
 * `--reporter=verbose`, in CI, and beside any failure; the claim here is that
 * the reason is written, not that every reporter shows it.
 */
const hasSearchApiKey = Boolean(process.env.GOOGLE_SEARCH_API)
if (process.env.LIVE_SUPPLIERS === '1' && !hasSearchApiKey) {
  console.warn(
    'LIVE_SUPPLIERS=1 with no GOOGLE_SEARCH_API: skipping the SearchApi live file. '
  + 'Kiwi needs no key, so the live flight file still runs.',
  )
}
export const describeLiveSearchApi =
  process.env.LIVE_SUPPLIERS === '1' && hasSearchApiKey ? describe : describe.skip

/**
 * The SearchApi key, read inside a test and never at module scope.
 *
 * This MUST be called from inside each `it`, never from the `describe`
 * callback. Vitest runs a suite's factory during COLLECTION even when the suite
 * is `describe.skip`, in order to enumerate its cases for the skip report, so a
 * throw in a describe body fires unconditionally, including on the offline
 * default run, and breaks `npm test` on every machine whose environment lacks
 * GOOGLE_SEARCH_API. Nothing that can throw may sit in a describe callback.
 *
 * With `describeLiveSearchApi` above deciding whether the file runs at all, the
 * throw here is unreachable rather than removed: it is what narrows
 * `string | undefined` to `string`, and it is the guard if a third live file is
 * ever declared with the wrong `describe`.
 */
export function requireSearchApiKey(): string {
  const apiKey = process.env.GOOGLE_SEARCH_API
  if (!apiKey) throw new Error('LIVE_SUPPLIERS=1 requires GOOGLE_SEARCH_API to be set')
  return apiKey
}

/**
 * The model canary, and nothing else in the suite, calls the provider. Its own
 * flag rather than `LIVE_SUPPLIERS`, because the two cost different money and a
 * reader who wants to check a supplier parser should not be billed for Opus.
 *
 * The flag AND the key, exactly as `describeLiveSearchApi` above gates: the
 * flag alone would run the file for a reader who set it without a key, and the
 * key read inside the `it` would then throw, which is a red suite rather than a
 * skip. Skipped WITH A PRINTED REASON for the same reason that one prints one,
 * because a silent skip is the other way to mislead the same reader.
 */
const hasModelKey = Boolean(process.env.ANTHROPIC_API_KEY)
if (process.env.LIVE_MODEL === '1' && !hasModelKey) {
  console.warn(
    'LIVE_MODEL=1 with no ANTHROPIC_API_KEY: skipping the drift canary. '
  + 'Every other model test in this suite replays a fixture and needs no key.',
  )
}
export const describeLiveModel =
  process.env.LIVE_MODEL === '1' && hasModelKey ? describe : describe.skip

/**
 * The author's key, read INSIDE a test and never at module scope, for the same
 * reason `requireSearchApiKey` gives: vitest runs a suite's factory during
 * collection even when the suite is `describe.skip`, so a throw in a describe
 * body fires on the offline default run and breaks `npm test` everywhere.
 *
 * With `describeLiveModel` above deciding whether the file runs at all, the
 * throw here is unreachable rather than removed: it is what narrows
 * `string | undefined` to `string`, and it is the guard if a third live file is
 * ever declared with the wrong `describe`.
 *
 * Returned and never logged. Nothing in this file, in the canary or in any
 * report the canary's output goes into may print it.
 */
export function requireModelKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('LIVE_MODEL=1 requires ANTHROPIC_API_KEY to be set')
  return apiKey
}
