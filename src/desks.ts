import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { SEATS, type Seat } from './seats.js'
import { TOOLS } from './tools.js'

export type DeskName = 'front' | 'planning'

export type Desk = {
  name: DeskName
  seat: Seat
  prompt: string
  /** First twelve hex characters of the prompt's SHA-256: a change to the file changes the version. */
  promptVersion: string
  tools: string[]
}

/** The doors out of each desk. The front desk has none, so an FAQ can never start a search. */
export const DESK_TOOLS: Record<DeskName, string[]> = {
  front: [],
  planning: ['search_flights', 'search_hotels', 'propose_itinerary'],
}

const DESK_SEATS: Record<DeskName, Seat> = { front: SEATS.cheap, planning: SEATS.driver }

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desks')

/** First twelve hex characters of a prompt's SHA-256: change the text, change the version. */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

export function loadDesk(name: DeskName): Desk {
  const prompt = readFileSync(path.join(DIR, `${name}-desk.md`), 'utf8')
  const sentinel = `<!-- desk: ${name} -->`
  if (!prompt.startsWith(sentinel)) throw new Error(`${name}-desk.md must start with ${sentinel}`)
  return {
    name,
    seat: DESK_SEATS[name],
    prompt,
    promptVersion: promptVersion(prompt),
    tools: DESK_TOOLS[name],
  }
}

export function toolsFor(desk: Desk): Tool[] {
  return TOOLS.filter((tool) => desk.tools.includes(tool.name))
}

/** Fills {{name}} slots; a slot with no value is an error, because a half-filled prompt reads as an instruction. */
export function renderPrompt(desk: Desk, vars: Record<string, string>): string {
  return desk.prompt.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`Prompt for ${desk.name} desk needs {{${key}}}`)
    return value
  })
}
