export type Rhythm =
  | 'weekly' | 'monthly' | 'quarterly'
  | 'per plan' | 'per dispatch' | 'per fix wave'

/**
 * One rhythm, what it is for, the command it has if it has one, and what a
 * person does that no command does.
 *
 * The last column is the one that makes this table worth carrying. A cadence
 * whose every row was a script would be a cron file, and the reason the loop
 * needs people is that three of these six rows have no command and cannot have
 * one.
 */
export type CadenceEntry = {
  rhythm: Rhythm
  who: 'the agency' | 'the people building it'
  what: string
  /** A real npm script, checked by test/cadence.test.ts, or null when a person is the mechanism. */
  command: string | null
  whatAPersonDoes: string
}

/**
 * Six rows. Three for the product and three for the agents that built it,
 * because the course spent seven modules being built by them and the rhythms
 * that worked are worth writing down beside the ones for the agency.
 */
export const CADENCE: readonly CadenceEntry[] = [
  {
    rhythm: 'weekly', who: 'the agency',
    what: 'read the worst conversations: rejected proposals, capped turns, escalations',
    command: 'worst',
    whatAPersonDoes: 'opens three of them and reads the transcripts. Thirty minutes of this '
      + 'finds what no metric names, and it is where next month\'s hypotheses come from. '
      + 'No query produces a hypothesis',
  },
  {
    rhythm: 'monthly', who: 'the agency',
    what: 're-select the desk examples, recompute judge agreement, spot-check provenance',
    command: 'examples',
    whatAPersonDoes: 'reads the diff and commits it, or does not. The selection is a query '
      + 'and the commit is a decision, and this module keeps them apart on purpose',
  },
  {
    rhythm: 'quarterly', who: 'the agency',
    what: 'count the labelled routing corpus and decide whether to fine-tune the front desk',
    command: null,
    whatAPersonDoes: 'decides, with the count in front of them. There is no command because '
      + 'executing the fine-tune is out of scope for this course, and because a corpus of the '
      + 'classifier\'s own unreviewed outputs is not a training set',
  },
  {
    rhythm: 'per plan', who: 'the people building it',
    what: 'a design review of the plan before a line of code is written',
    command: null,
    whatAPersonDoes: 'scans their own plan hardest. The pre-flight scan of one plan its own '
      + 'author wrote found twenty-nine conflicts and six blocking ones, and the rate did not '
      + 'improve on the second plan. Authorship provides no immunity, and a scan finds '
      + 'contradictions between stated things and never an omission',
  },
  {
    rhythm: 'per dispatch', who: 'the people building it',
    what: 'one implementer at a time; reviews may run beside an implementer, a second may not',
    command: null,
    whatAPersonDoes: 'holds the queue. A parallel run contaminated a test count once, reporting '
      + 'a figure that included another task\'s in-flight tests, and a subagent that pushes back '
      + 'on the instruction it was given is doing the job rather than failing it',
  },
  {
    rhythm: 'per fix wave', who: 'the people building it',
    what: 'same-shape findings go out as one dispatch and come back as one diff',
    command: null,
    whatAPersonDoes: 'groups them, and proves each fix discriminates by breaking the guarded '
      + 'constraint and reverting, which is the same move lesson 7.3 makes on its own test',
  },
] as const

export function renderCadence(entries: readonly CadenceEntry[]): string {
  const width = Math.max(...entries.map((e) => e.rhythm.length))
  return entries
    .map((e) => `  ${e.rhythm.padEnd(width)}  ${e.command ? `npm run ${e.command}` : 'a person'}`
      + `  ${e.what}`)
    .join('\n')
}
