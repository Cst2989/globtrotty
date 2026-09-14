import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEATS, type Seat } from './seats.js'
import { type Desk } from './tools/registry.js'

/**
 * A desk prompt, loaded and versioned. Renamed from `Desk` at lesson 5.2:
 * `Desk` is now the union of desk NAMES and lives in src/tools/registry.ts
 * beside the allowlist, and one module cannot export two things called Desk.
 * The record kept the longer name rather than the union, because the union is
 * the one written at call sites: `loadDesk('planning')`, `toolsForDesk(desk)`,
 * `DESK_TOOLS[desk]`.
 *
 * `tools` is gone. It duplicated `DESK_TOOLS[name]` into a second object, so a
 * tool added to the registry and not to the desk record would have advertised
 * one list and validated against another.
 */
export type LoadedDesk = {
  name: Desk
  seat: Seat
  prompt: string
  /** First twelve hex characters of the prompt's SHA-256: a change to the file changes the version. */
  promptVersion: string
}

/**
 * The seat each desk's prompt is READ for, which is `turn()`'s question
 * (src/conversation.ts). It is deliberately not the driver's: `makeDriver` picks
 * `SEATS.front_desk` or `SEATS.driver` from the desk NAME `selectDesk` chose, and
 * the front desk's row here stays `cheap` because that is the name `turn()`'s
 * front-desk calls are already recorded under in course.model_calls and
 * `test/model-calls.test.ts` pins them.
 */
const DESK_SEATS: Record<Desk, Seat> = { front: SEATS.cheap, planning: SEATS.driver }

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desks')

/** First twelve hex characters of a prompt's SHA-256: change the text, change the version. */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Everything between `<!--` and `-->`, taken out before the prompt is anything a
 * model can see.
 *
 * The file's own markers are for us: the desk marker `loadDesk` checks below,
 * and the sentinel line `npm run sentinels` greps for. Neither is an
 * instruction, so neither belongs in the bytes we pay input tokens for, and the
 * sentinel in particular is documented as a string that "must never appear in
 * anything we deploy" (scripts/sentinels.ts). The grep cannot see the one
 * exfiltration path a prompt really has here, which is the model repeating its
 * instructions to a traveller and `completeTurn` writing that reply to
 * course.messages, so the string is removed rather than watched.
 *
 * It runs before `promptVersion`, so the hash is over the bytes that were SENT,
 * which is the property src/classify.ts argues a prompt version should have: an
 * edit to a comment is not a new prompt, and an edit to an instruction is.
 */
function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->[ \t]*\n?/g, '').replace(/^\n+/, '')
}

/**
 * Any prompt file this product owns, loaded the one way a prompt may be loaded:
 * comments out before the bytes are sent, and the version hashed over what was
 * sent rather than over what was on disk.
 *
 * Extracted from `loadDesk` at lesson 5.4's fix round, because the scout prompt
 * (src/agents/prompts/scout.md) is a prompt we own that does not live in
 * src/desks, has no `{{slot}}` and no seat of its own, and was reading its file
 * raw. Two consequences followed from that, and both are closed by routing it
 * through here. Its `<!-- scout -->` marker was on the wire, so it would have
 * carried a sentinel to the model the moment one was added, and its
 * `course.model_calls.prompt_version` hashed bytes including the marker, so a
 * comment-only edit minted a new prompt version on the scout seat and not on
 * any desk seat. Lesson 5.7's monitor reads those rows.
 *
 * `marker` is checked against the RAW file, because the marker is one of the
 * comments `withoutComments` removes: a prompt that has lost its marker is a
 * file somebody copied without reading, and the whole point is to catch that
 * before it is sent.
 */
export function loadPrompt(
  file: string | URL, marker: string,
): { prompt: string; promptVersion: string } {
  const raw = readFileSync(file, 'utf8')
  if (!raw.startsWith(marker)) throw new Error(`${String(file)} must start with ${marker}`)
  const prompt = withoutComments(raw)
  return { prompt, promptVersion: promptVersion(prompt) }
}

const EXAMPLES_DIR = path.join(DIR, 'examples')

/**
 * The examples file for a desk, comment-stripped, or the empty string when
 * there is none.
 *
 * A missing file is not an error. The front desk has no examples and never
 * will, because it publishes no tools and an example of a booked itinerary is
 * not something an FAQ answer can act on, and a fresh checkout of this
 * repository has no planning examples either until somebody runs the refresh
 * and commits its output.
 *
 * Read through the same comment stripper the desk file goes through, so the
 * provenance block never reaches the model and never enters the hash.
 */
function loadExamples(name: Desk): string {
  const file = path.join(EXAMPLES_DIR, `${name}.md`)
  if (!existsSync(file)) return ''
  return withoutComments(readFileSync(file, 'utf8')).trim()
}

/**
 * The desk prompt with its examples assembled onto the end, versioned over the
 * ASSEMBLED bytes.
 *
 * Assembled here rather than rendered into a `{{slot}}`, and the difference is
 * the whole reason this function changed. `renderPrompt` fills slots AFTER
 * `promptVersion` has hashed the file, so an example set delivered through a
 * slot would change what the model reads and leave
 * course.model_calls.prompt_version identical. Every measurement in module 7
 * that compares two prompt versions would then be comparing one.
 *
 * The examples go last, after the instructions, because the prefix is what the
 * cache breakpoints are placed against (lesson 5.6) and the part that changes
 * monthly belongs behind the part that changes rarely.
 */
export function loadDesk(name: Desk): LoadedDesk {
  const base = loadPrompt(path.join(DIR, `${name}-desk.md`), `<!-- desk: ${name} -->`)
  const examples = loadExamples(name)
  const prompt = examples === '' ? base.prompt : `${base.prompt}\n\n${examples}`
  return { name, seat: DESK_SEATS[name], prompt, promptVersion: promptVersion(prompt) }
}

/** Fills {{name}} slots; a slot with no value is an error, because a half-filled prompt reads as an instruction. */
export function renderPrompt(desk: LoadedDesk, vars: Record<string, string>): string {
  return desk.prompt.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`Prompt for ${desk.name} desk needs {{${key}}}`)
    return value
  })
}
