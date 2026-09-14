import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SENTINELS } from '../scripts/sentinels.js'
import { loadDesk, promptVersion, renderPrompt } from '../src/desks.js'
import { emptyNotebook } from '../src/notebook.js'
import { DESK_TOOLS, toolsForDesk, type Desk } from '../src/tools/registry.js'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The directory loadDesk reads, derived the same way loadDesk derives it, so
// this stays right if the prompts move.
const DESK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'desks')

/**
 * The two files a reader can run that compose the product's driver and drive a
 * desk.
 *
 * LISTED, and then checked. A guard that finds its subject through prose stops
 * finding it the day someone tidies a sentence, and it stops SILENTLY, still
 * green, with the deployed chain no longer looked at; that is what the old
 * `turn(` grep did, matching two docstrings. The marker is `makeDriver(`, since
 * lesson 5.3 put `npm run trip` on the same driver tier 3 runs, and building
 * `makeDriver` is what "sends a desk's tools to a model" means on this branch
 * (`runTurn(` would be worse: `scripts/demo.ts` calls it with an agent that
 * publishes no tools). A file that stops building the driver drops out of the
 * filter and fails the equality below by name, which is the loud failure a
 * directory walk could not produce.
 */
const DRIVER_FILES = [
  'netlify/functions/run-turn-background.mts',
  'scripts/trip.ts',
  // Lesson 6.3's third composer. The eval drives the real handler and the
  // real worker through a chain of its own (`chainFor`,
  // src/evals/conversation.ts), so a wrapper a later lesson adds to the other
  // two and not to that one would have the golden cases grading a desk that
  // answers "Unknown tool" out of `supplierRunner`, and the card would call it
  // a trajectory failure.
  'src/evals/conversation.ts',
] as const

function drivers(): string[] {
  return DRIVER_FILES
    .filter((file) => /\bmakeDriver\(/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
    .slice()
    .sort()
}

describe('desks', () => {
  it('gives the front desk no tools at all, gates included', () => {
    expect(toolsForDesk('front')).toEqual([])
    expect(DESK_TOOLS.front).toEqual([])
  })
  it('lets the planning desk write the notebook, ask, scout, search, propose, revise and escalate', () => {
    // The last two are lesson 5.7's: one line of a card changed, and a request
    // handed to a person. Both are `door: 'code'`, and both are on the planning
    // desk only, because the front desk publishes no tools at all.
    expect((toolsForDesk('planning') as { name: string }[]).map((t) => t.name))
      .toEqual(['update_requirements', 'ask_user', 'research_destination', 'search_flights',
                'search_hotels', 'propose_itinerary', 'hand_off_to_booking',
                'revise_component', 'escalate_to_human'])
  })
  it('seats the front desk on Haiku and the planning desk on Opus', () => {
    expect(loadDesk('front').seat.model).toBe('claude-haiku-4-5-20251001')
    expect(loadDesk('planning').seat.model).toBe('claude-opus-5')
  })
  it('versions a prompt by its content', () => {
    const desk = loadDesk('planning')
    expect(desk.promptVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(loadDesk('front').promptVersion).not.toBe(desk.promptVersion)
  })
  it('changes the version when the file changes', () => {
    // The hash is of the file's own bytes, so a prompt edit is a new
    // prompt_version in course.model_calls without anyone remembering to bump a
    // string. That is the difference from a hand-maintained 'planning@1', which
    // is right until the first edit somebody makes in a hurry.
    const desk = loadDesk('planning')
    expect(desk.promptVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(promptVersion(desk.prompt)).toBe(desk.promptVersion)
    expect(promptVersion(`${desk.prompt} `)).not.toBe(desk.promptVersion)
  })

  it('never sends a sentinel, or any other HTML comment, to the provider', () => {
    // The one exfiltration path this repository actually has for a prompt is
    // the model repeating its instructions to a traveller, whose reply
    // `completeTurn` writes to course.messages. `npm run sentinels` cannot see
    // that path at all: it greps files, and the prompt file is allowed to hold
    // its own sentinel. So the string that "must never appear in anything we
    // deploy" has to be taken OUT of the bytes we send, and this is the
    // assertion that says it was.
    //
    // The patterns come from the check itself rather than being spelled again
    // here, so a sentinel renamed in one place cannot be missed in the other.
    for (const name of ['front', 'planning'] as const) {
      const system = renderPrompt(loadDesk(name), name === 'front' ? {} : { today: '2026-09-13' })
      expect(system).not.toContain('<!--')
      for (const s of SENTINELS) {
        expect(s.pattern.test(system), `${name} desk sends ${s.name}`).toBe(false)
      }
    }
  })

  it('gives the front desk no doors at all', () => {
    expect(toolsForDesk('front')).toEqual([])
  })

  it('refuses a prompt file that lost its desk marker', () => {
    // loadDesk requires the first line, and takes ONE argument: it resolves the
    // path itself from the desk name, so there is no path to point at a fixture
    // with. The marker is checked by writing a file into the directory loadDesk
    // reads and taking it away again, which is the only way to reach the throw
    // without widening the function's signature for a test.
    const stray = path.join(DESK_DIR, 'stray-desk.md')
    writeFileSync(stray, 'You are a desk with no marker.\n')
    try {
      expect(() => loadDesk('stray' as Desk)).toThrow(/must start with/)
    } finally {
      rmSync(stray)
    }
  })

  it('refuses to render a prompt with an unfilled slot', () => {
    // `{{today}}` is the planning desk's only slot from lesson 5.2, so the
    // prompt that can be left half-filled is the one rendered with nothing at
    // all. The notebook used to fill `{{requirements}}` here and now rides in
    // the request's suffix (src/model/client.ts), where it lands after the
    // cache breakpoint instead of inside the stable prefix.
    expect(() => renderPrompt(loadDesk('planning'), {})).toThrow(/today/)
  })

  /**
   * The tool list above is what BOTH drivers send, because both build
   * `makeDriver`, which publishes `toolsForDesk(deskName)` (src/agents/driver.ts)
   * and picks the planning desk for everything that is not a short factual
   * question. So a driver
   * whose runner chain has no `proposalRunner` in it advertises
   * `propose_itinerary` to the model, is asked for it, and answers "Unknown
   * tool propose_itinerary" from `supplierRunner`, the innermost link. No gate
   * runs, no `course.gate_results` row is written, and the model goes back to
   * quoting prices in prose, which is the failure this module exists to remove.
   *
   * That is what `npm run trip` did until this fix, while tier 3 was wired, so
   * the one command the README points a reader at was the one that could not
   * propose. It is a source check and not a behavioural one on purpose: the
   * chain is composed inside a script whose first statement opens a database
   * connection and calls a live model, so there is nothing here to call without
   * a key, and the habit is what the guard has to be able to see.
   *
   * One wrapper per tool this desk publishes beyond the two searches, which is
   * why the pairs below are derived from `DESK_TOOLS.planning` rather than
   * listed twice: lesson 4.6 added `hand_off_to_booking` to that list and a
   * guard that still only looked for `proposalRunner` would have watched the
   * new tool go out unanswered, which is the exact regression this case exists
   * to make impossible. Lesson 5.2 moved the registry inside the harness and
   * added two tools to this desk, and lesson 5.4 added `research_destination`
   * and `scoutRunner` with it; a chain that loses a wrapper fails here first.
   * Lesson 5.7 added `revise_component` and `escalate_to_human` and their two
   * wrappers, and this case is where forgetting either of them would have
   * surfaced: a card with a change button that answers "Unknown tool
   * revise_component" is worse than a card with no change button.
   */
  it('wires a runner for every tool the planning desk sends into every driver', () => {
    const wrappers: Record<string, string> = {
      update_requirements: 'notebookRunner',
      research_destination: 'scoutRunner',
      propose_itinerary: 'proposalRunner',
      hand_off_to_booking: 'cashierRunner',
      revise_component: 'cardRunner',
      escalate_to_human: 'escalationRunner',
    }
    /**
     * `ask_user` is answered by the DRIVER and never by the chain: it is a
     * terminal message step (src/agents/driver.ts, lesson 5.2), because the
     * answer comes from her rather than from a tool, so there is no wrapper to
     * look for and its absence from `wrappers` is a statement rather than an
     * omission. It used to cost `npm run trip` a tool, because that path ran
     * `toolLoop`, which has no step that ends a turn on a question; lesson 5.3
     * put the script on the driver and both paths now park the turn on her
     * question.
     */
    const answeredByTheDriver = ['ask_user']
    // Derived, so a tool added to the desk with no wrapper named here fails
    // this line rather than passing unnoticed.
    const needed = DESK_TOOLS.planning
      .filter((tool) => !tool.startsWith('search_') && !answeredByTheDriver.includes(tool))
      .map((tool) => wrappers[tool] ?? `NO WRAPPER NAMED FOR ${tool}`)
    expect(needed).toEqual(['notebookRunner', 'scoutRunner', 'proposalRunner', 'cashierRunner',
                            'cardRunner', 'escalationRunner'])
    expect(drivers()).toEqual(['netlify/functions/run-turn-background.mts', 'scripts/trip.ts',
                              'src/evals/conversation.ts'])
    for (const file of drivers()) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const wrapper of needed) {
        expect(source, `${file} sends a tool ${wrapper} answers and does not wrap it`)
          .toMatch(new RegExp(`${wrapper}\\(`))
      }
    }
  })

  /**
   * The notebook's field names, pinned between the schema that accepts them and
   * the prompt that teaches them.
   *
   * Lesson 6.3 put the eight names into the planning desk's prompt because
   * nothing else told the model what they were, and `applyRequirements`
   * (src/notebook.ts) refuses a patch WHOLE when one key is unrecognised, so a
   * desk guessing names wrote nothing at all and every turn after the first
   * started with an empty notebook. That paragraph is now the only place a model
   * learns the vocabulary, which makes it exactly the kind of list this branch
   * guards everywhere else it has two readers: `SENTINELS`, `GATE_NAMES`,
   * `CONVERSATION_STATUSES`, the chain above.
   *
   * Derived from `emptyNotebook()` rather than typed out here, so a ninth field
   * fails this line rather than going unmentioned to the model, which is the
   * failure mode that cost this lesson three recordings to find.
   */
  it('teaches the planning desk every notebook field the schema accepts', () => {
    const prompt = loadDesk('planning').prompt
    const fields = Object.keys(emptyNotebook())
    expect(fields).toHaveLength(8)
    for (const field of fields) {
      expect(prompt, `the planning desk prompt never names the notebook field ${field}`)
        .toContain(`\`${field}\``)
    }
  })
})
