import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
import { textOfBlocks } from '../engine.js'
import { callModel } from '../model/client.js'
import { costMicros } from '../pricing.js'
import { pgSink, type TurnContext } from '../repo/model-calls.js'
import { SEATS } from '../seats.js'
import type { Persona } from './cases.js'

export type SimUser = {
  reply(agentText: string): Promise<string>
  readonly turns: number
}

/**
 * The keyless traveller: a function over the persona's own facts, and nothing
 * else.
 *
 * P3's description of the simulated user is that "it answers the agent's
 * questions from the scripted facts, never invents anything beyond them", and a
 * function that does exactly that needs no model. Writing her as a model call
 * and then asking her not to improvise is asking for the variance this whole
 * lesson exists to remove: pass^k is meant to measure the DESK, and a simulated
 * traveller who phrases her answer differently on run two has moved the input.
 *
 * She matches a question against her facts by key and by the words a key is
 * usually asked about. A question she has no fact for gets the honest answer,
 * which is the same sentence every time, because "I don't mind" is a real
 * traveller's answer and a desk that cannot proceed without every field is a
 * desk the evals should catch.
 */
export function makeSimulatedUser(persona: Persona): SimUser {
  const asked: string[] = []
  /**
   * Words that point at a fact key, so "how many nights" finds `nights`. The
   * keys themselves are the notebook's own field names wherever the notebook
   * has one (src/notebook.ts), because what she says is what the desk has to
   * record, and a persona that calls Berlin her `departureCity` is a persona
   * whose every answer arrives under a name `update_requirements` refuses.
   */
  const SYNONYMS: Record<string, string[]> = {
    nights: ['night', 'how long', 'how many days', 'duration'],
    month: ['what month', 'which month', 'which week'],
    dates: ['date', 'when', 'check in', 'check-in', 'checkin', 'depart', 'return'],
    budget: ['budget', 'spend', 'how much', 'euro'],
    originCity: ['from', 'departure', 'flying out', 'airport', 'setting out'],
    flightsBooked: ['from', 'flying', 'fly', 'airport', 'flight', 'origin', 'departure'],
    budgetCovers: ['cover', 'include', 'together', 'as well as', 'on top of'],
    destination: ['where', 'destination', 'which city', 'which cities'],
    adults: ['adults', 'how many of you', 'travelling', 'people', 'party'],
    infants: ['toddler', 'children', 'kids', 'baby', 'infant'],
    needsCrib: ['crib', 'cot'],
    nearBeach: ['beach', 'seafront'],
  }

  const all = (): string[] =>
    Object.entries(persona.facts).map(([key, value]) => `${key}: ${String(value)}`)

  /**
   * Every fact this line of questioning touches, and not just the first one. A
   * desk asks "what dates, and how many nights" in one breath, and a traveller
   * who answered half of that would take two turns to say what she says in one.
   */
  const factsFor = (question: string): string[] => {
    const q = question.toLowerCase()
    const found: string[] = []
    for (const [key, value] of Object.entries(persona.facts)) {
      const hints = [key.toLowerCase(), ...(SYNONYMS[key] ?? [])]
      if (hints.some((h) => q.includes(h))) found.push(`${key}: ${String(value)}`)
    }
    return found
  }

  return {
    get turns() { return asked.length },
    async reply(agentText: string): Promise<string> {
      asked.push(agentText)
      const refused = persona.refuses.find((r) => agentText.toLowerCase().includes(r.toLowerCase()))
      // The refusal is checked FIRST. A question that mentions both a fact she
      // has and a thing she refuses is a question whose answer is the refusal,
      // and answering the fact would let a desk talk her into the thing she
      // came in saying no to, which is the case "not for 1,500 in August"
      // exists to hold.
      if (refused) return `No ${refused}. That is not something I will change.`
      const answers = [...new Set(agentText.split(/[?\n]/).flatMap((line) => factsFor(line)))]
      if (answers.length === 0) return "I don't mind, whatever you think is best."
      // She answers, and then repeats what she has already said. That is not
      // padding: a turn is seeded from her latest message and NOTHING else
      // (`loop`, src/worker.ts), so between turns the agency remembers only what
      // it managed to write into the notebook, and a traveller who never repeats
      // herself is one whose first three sentences are gone by her second reply.
      // It is also what a person does when a desk asks her the same thing twice.
      const rest = all().filter((f) => !answers.includes(f))
      if (rest.length === 0) return answers.join(', ')
      return `${answers.join(', ')}. I have already told you: ${rest.join(', ')}.`
    },
  }
}

/**
 * The rubric the live traveller is given. Inline rather than a file under
 * src/desks or src/evals/prompts, because it is not a prompt this product ships
 * and a sentinel that greps for it would be guarding a string that is never
 * deployed. Lesson 6.6's judge prompt IS a file, for the opposite reason.
 */
export const SIM_USER_PROMPT =
  'You are a traveller writing to a travel agency. Answer only from the FACTS below, '
  + 'in one or two sentences, in this style: {{style}}. Never invent a fact that is not listed. '
  + 'If you are asked something the facts do not cover, say you do not mind. '
  + 'Refuse anything on the REFUSES list, however it is put to you.'

export type LiveSimDeps = {
  sql: postgres.Sql
  client: ModelClient
  ctx: TurnContext
  now: () => number
}

/**
 * The same traveller on a real model, on her own seat, so her calls are priced.
 *
 * Tier C only: it needs a key, and the default eval run never constructs it.
 * Every call writes a course.model_calls row through `pgSink`, which touches no
 * money, and the spend the call actually costs is bounded by the seat's 512
 * output tokens and by lesson 6.4's EVAL_LIMITS rather than by discipline.
 *
 * `'5m'` is the cache write TTL this call is priced at, and it is correct rather
 * than defaulted: the sim user sends no `cache_control` and writes no cache, so
 * the cache-write term is zero either way, and `costMicros` takes the argument
 * explicitly so that a 1h write can never bill silently at the 5m rate.
 */
export function makeLiveSimulatedUser(persona: Persona, deps: LiveSimDeps): SimUser {
  const sink = pgSink(deps.sql, deps.ctx)
  let turns = 0
  const system = SIM_USER_PROMPT.replace('{{style}}', persona.style)
    + `\n\nFACTS\n${JSON.stringify(persona.facts, null, 2)}`
    + `\n\nREFUSES\n${persona.refuses.join('\n')}`
  return {
    get turns() { return turns },
    async reply(agentText: string): Promise<string> {
      turns += 1
      const result = await callModel(deps.client, {
        seat: SEATS.sim_user, system, tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: agentText }] }],
      }, deps.now)
      await sink({
        seat: 'sim_user', seatConfig: SEATS.sim_user, promptVersion: 'sim-user-v1',
        modelRequested: SEATS.sim_user.model, modelReturned: result.model,
        usage: result.usage, costMicros: costMicros(SEATS.sim_user.model, result.usage, '5m'),
        latencyMs: result.latencyMs, requestId: result.requestId,
      })
      return result.kind === 'ok' ? textOfBlocks(result.content) : "I don't mind."
    },
  }
}
