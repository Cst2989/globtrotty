import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

export function loadDesk(name: Desk): LoadedDesk {
  const file = readFileSync(path.join(DIR, `${name}-desk.md`), 'utf8')
  const sentinel = `<!-- desk: ${name} -->`
  // Checked against the FILE, because the marker is one of the comments the
  // line below removes: a desk whose prompt has lost its marker is a file
  // somebody copied without reading, and the whole point is to catch that
  // before it is sent.
  if (!file.startsWith(sentinel)) throw new Error(`${name}-desk.md must start with ${sentinel}`)
  const prompt = withoutComments(file)
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
