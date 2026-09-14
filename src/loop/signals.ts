/**
 * One kind of row the agency already holds, and what it is worth.
 *
 * A typed constant rather than a markdown table in a lesson, for the reason
 * every constant on this branch is one: the lesson prints THIS, so the lesson
 * and the tree cannot drift, and `home` is checkable against the catalogue
 * (test/signals.test.ts).
 */
export type SignalRow = {
  signal: string
  /** The table the row actually lives in on this branch, checked against the catalogue. */
  home: string
  perRow: string
  saysWhat: string
}

/**
 * Ranked by information per row, highest first, which is P4's ordering and not
 * a new one.
 *
 * Three rows and not four. P4's fourth is the watcher's own signal, how often
 * her answer to "your flight died, here's a rebooking" is yes, and there is no
 * watcher on this branch: SPEC's non-goals removed it. A row for it here would
 * be a signal with no table, which is the exact defect the `home` column exists
 * to make impossible.
 *
 * The second row is where this branch diverges from SPEC section 6 on purpose.
 * SPEC models her answer as approve, edit or reject, and `0013` allows two
 * values, accept and reject, frozen. On this branch an EDIT is a
 * `revise_component` call against the proposal she is looking at: SPEC section
 * 9 calls per-component actions "a categorical learning signal instead of free
 * text that mixes 'too expensive' with 'actually, Spain'", and the slot she
 * named is that category. So the edit is not a third decision value, it is a
 * tool call, and it is read out of the transcript rather than out of a column.
 */
export const SIGNALS: readonly SignalRow[] = [
  {
    signal: 'her decision',
    home: 'proposals',
    perRow: 'one graded example per proposal',
    saysWhat: 'accept is a graded example of what she wanted and reject is a graded '
      + 'example of what she did not, both worth more than any rating widget, because '
      + 'a widget asks for extra work and gets noise',
  },
  {
    signal: 'her edits',
    home: 'turns',
    perRow: 'one named slot per revise_component call',
    saysWhat: 'what was almost right, and which part was not. The slot is the category: '
      + 'a hotel swapped is a hotel-scoring signal and dates shifted is a flexibility '
      + 'signal. Read out of course.turns.state, the transcript, because course.tool_calls '
      + 'is written only by ledgerRunner and a chain without the ledger holds nothing there',
  },
  {
    signal: 'her booking',
    home: 'conversions',
    perRow: 'one row per trip, arriving months late',
    saysWhat: 'how the whole desk performs, per prompt version. When a prompt change '
      + 'ships and conversion drops, the evals passed and the users voted, and the users win',
  },
] as const

/** The table the lesson prints, from the constant the tests check. */
export function renderSignals(rows: readonly SignalRow[]): string {
  const width = Math.max(...rows.map((r) => r.signal.length))
  return rows
    .map((r) => `  ${r.signal.padEnd(width)}  course.${r.home.padEnd(12)}  ${r.perRow}`)
    .join('\n')
}
