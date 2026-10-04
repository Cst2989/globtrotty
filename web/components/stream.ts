/**
 * Plan: streamed reveal. Pure timing math for `StreamedText` (`./StreamedText.tsx`) — no DOM, no
 * timers, so it is unit-tested directly (`test/web-render.test.ts`).
 *
 * The reveal is word-at-a-time, never mid-word: `revealSchedule` walks `text` with a global
 * "non-space run plus trailing space" match, so each step's `upTo` lands right after a word plus
 * whatever whitespace follows it (up to the next word, or the end of the string for the last
 * one). Slicing `text` at any `upTo` — or at 0 — can therefore never split a word.
 *
 * The pace ramps rather than ticking at a fixed rate, the way Claude/ChatGPT's own streaming
 * reads: it starts at `START_WPS` words/sec, climbs linearly to `END_WPS` over `RAMP_MS`, and
 * holds `END_WPS` after that. `msForWordCount` is the closed-form inverse of the words-revealed
 * curve (a quadratic during the ramp, linear after it), so each word's timestamp is computed
 * directly rather than simulated step by step.
 */
export type RevealStep = { at: number; upTo: number }

const RAMP_MS = 1000
const START_WPS = 25
const END_WPS = 70
/** Words revealed by the time the ramp finishes (the area under the ramp's rate curve). */
const WORDS_AT_RAMP_END = ((START_WPS + END_WPS) / 2) * (RAMP_MS / 1000)

/** The ms timestamp at which the `k`th word (1-indexed) finishes revealing. */
function msForWordCount(k: number): number {
  if (k <= 0) return 0
  if (k <= WORDS_AT_RAMP_END) {
    // words(t) = START_WPS * t + (END_WPS - START_WPS) / 2 * t^2  (t in seconds)
    // Solve for t given words(t) = k.
    const a = (END_WPS - START_WPS) / 2
    const b = START_WPS
    const c = -k
    const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)
    return t * 1000
  }
  const t = RAMP_MS / 1000 + (k - WORDS_AT_RAMP_END) / END_WPS
  return t * 1000
}

/**
 * Word-boundary cumulative reveal schedule for `text`. Empty for text with no words (nothing to
 * animate); monotonic in both `at` and `upTo`; the final step's `upTo` is always `text.length`.
 */
export function revealSchedule(text: string): RevealStep[] {
  const endings: number[] = []
  const re = /\S+\s*/g
  let match: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign -- the standard RegExp#exec iteration idiom.
  while ((match = re.exec(text)) !== null) {
    endings.push(match.index + match[0].length)
  }
  if (endings.length === 0) return []

  const steps: RevealStep[] = []
  let previousAt = -1
  for (let i = 0; i < endings.length; i++) {
    let at = Math.round(msForWordCount(i + 1))
    if (at <= previousAt) at = previousAt + 1
    steps.push({ at, upTo: endings[i]! })
    previousAt = at
  }
  // The last word's ending is wherever the regex stopped matching; trailing whitespace the regex
  // could not attach to a word (there is none, by construction) would otherwise leave the final
  // step short of `text.length`. Guard it anyway, so the invariant holds even for unusual input.
  steps[steps.length - 1]!.upTo = text.length
  return steps
}

/**
 * The text visible at `elapsedMs` into a reveal: always a prefix of `text` ending exactly at a
 * step's `upTo` (or empty), so it can never land mid-word. `schedule` is the same shape
 * `revealSchedule` returns — callers that tick frequently should compute it once and pass it in
 * rather than re-deriving it every frame.
 */
export function visibleSlice(text: string, elapsedMs: number, schedule?: RevealStep[]): string {
  const steps = schedule ?? revealSchedule(text)
  if (steps.length === 0) return text
  if (elapsedMs <= 0) return ''
  let upTo = 0
  for (const step of steps) {
    if (elapsedMs >= step.at) upTo = step.upTo
    else break
  }
  return text.slice(0, upTo)
}
