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

const DESK_SEATS: Record<Desk, Seat> = { front: SEATS.cheap, planning: SEATS.driver }

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desks')

/** First twelve hex characters of a prompt's SHA-256: change the text, change the version. */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

export function loadDesk(name: Desk): LoadedDesk {
  const prompt = readFileSync(path.join(DIR, `${name}-desk.md`), 'utf8')
  const sentinel = `<!-- desk: ${name} -->`
  if (!prompt.startsWith(sentinel)) throw new Error(`${name}-desk.md must start with ${sentinel}`)
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
