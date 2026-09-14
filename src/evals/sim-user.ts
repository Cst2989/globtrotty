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
  /**
   * What she has refused so far, by the `what` of each refusal, in the order she
   * refused it.
   *
   * `runCase` reads it to end a case that is going in circles: a traveller who
   * has said no to the same thing twice has said everything this case is going
   * to learn, and every turn after that is spend for nothing. It is on the
   * traveller rather than derived from her text by the runner, because the
   * runner would have to parse her sentences back into the persona's words to
   * get it, and a matcher on both sides of one string is two things to keep in
   * step.
   *
   * Always empty on the LIVE traveller: her refusals are prose a model wrote and
   * nothing here reads them back, which is one more reason the default is the
   * scripted one.
   */
  readonly refused: readonly string[]
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
 * She types SENTENCES. The first version of this function answered with the
 * facts it matched and then appended every remaining fact after "I have already
 * told you", which meant the desk was handed the notebook read back at it in the
 * notebook's own field names on every single turn. Three things were wrong with
 * that and all three are visible in the recordings it produced: the lesson
 * claims a person is typing and the fixtures showed a field list, the persona's
 * `style` was written down and never used, and a desk told ten facts at once
 * under a prompt that says "one patch per fact" sends ten patches. So she
 * answers what she was asked, in at most three clauses, in her persona's style,
 * and she does not repeat what nobody asked about.
 *
 * She still invents nothing. Every clause is one of her own facts rendered
 * through a fixed phrasing, and a question she has no fact for gets the honest
 * answer, which is the same sentence every time, because "I don't mind" is a
 * real traveller's answer and a desk that cannot proceed without every field is
 * a desk the evals should catch.
 *
 * Pure and deterministic: the same persona and the same agent text give the same
 * string, on a fresh instance or the same one. Nothing here reads a clock, a
 * random number or the turn count.
 */
export function makeSimulatedUser(persona: Persona): SimUser {
  const asked: string[] = []
  const refused: string[] = []
  /**
   * Words that point at a fact key, so "how many nights" finds `nights`. The
   * keys themselves are the notebook's own field names wherever the notebook has
   * one (src/notebook.ts), `partySize` included, because what she says is what
   * the desk has to record, and a persona that calls her party `adults` and
   * `infants` costs the desk a translation step on every turn.
   */
  const SYNONYMS: Record<string, string[]> = {
    nights: ['night', 'how long', 'how many days', 'duration'],
    month: ['what month', 'which month', 'which week'],
    dates: ['date', 'when', 'check in', 'check-in', 'checkin', 'depart', 'return'],
    budget: ['budget', 'spend', 'how much', 'euro'],
    originCity: ['from', 'departure', 'flying out', 'airport', 'setting out'],
    // Not a bare 'where': "where are you flying FROM" is a question about her
    // origin, and a destination clause in the answer to it is a traveller
    // volunteering something nobody asked about.
    destination: ['destination', 'which city', 'which cities', 'where would you like',
                  'where to', 'where are you going'],
    partySize: ['adults', 'children', 'kids', 'toddler', 'baby', 'infant', 'people',
                'party', 'travelling', 'travellers', 'how many of you'],
    needsCrib: ['crib', 'cot'],
    nearBeach: ['beach', 'seafront'],
    budgetCovers: ['cover', 'include', 'together', 'as well as', 'on top of'],
    flightsBooked: ['flying', 'fly', 'flight', 'origin'],
  }

  /**
   * How each fact sounds when a person says it. A fact with no entry here falls
   * back to "its <key> is <value>", which is ugly on purpose: a persona field
   * nobody has taught her to say should read like something nobody wrote rather
   * than quietly pass for prose.
   */
  const PHRASING: Record<string, (value: string) => string> = {
    originCity: (v) => `we fly out of ${v}`,
    destination: (v) => `we want to go to ${v}`,
    month: (v) => `we are looking at ${v}`,
    dates: (v) => `${v} works for us`,
    nights: (v) => `${v} nights`,
    partySize: (v) => `it is ${v}`,
    budget: (v) => `our budget is ${v}`,
    budgetCovers: (v) => `that has to cover ${v}`,
    flexibleDates: (v) => (v === 'true' ? 'our dates are flexible' : 'our dates are fixed'),
    needsCrib: (v) => (v === 'true' ? 'we need a crib in the room' : 'we do not need a crib'),
    nearBeach: (v) => (v === 'true' ? 'we want to be near a beach' : 'we do not need a beach'),
    flightsBooked: (v) => v,
  }

  /**
   * At most three clauses, because a desk may ask three questions (`AskUser`,
   * src/tools/registry.ts, caps it at three) and a traveller who answered nine
   * would be back to reciting her persona.
   */
  const MAX_CLAUSES = 3

  /**
   * Her style, applied. `style` is free text a case author wrote, so the one
   * thing read out of it is whether she types in lower case, which the phrasings
   * above already are. Everything else about a style a fixed function cannot
   * honour is honoured by the LIVE traveller below, which is given the whole
   * string.
   */
  const lowercase = persona.style.toLowerCase().includes('lowercase')
  const styled = (text: string): string =>
    (lowercase ? text.toLowerCase() : text.charAt(0).toUpperCase() + text.slice(1))

  const factsFor = (question: string): string[] => {
    const q = question.toLowerCase()
    const found: string[] = []
    for (const [key, value] of Object.entries(persona.facts)) {
      const hints = [key.toLowerCase(), ...(SYNONYMS[key] ?? [])]
      if (!hints.some((h) => q.includes(h))) continue
      const say = PHRASING[key] ?? ((v: string) => `its ${key} is ${v}`)
      found.push(say(String(value)))
    }
    return found
  }

  return {
    get turns() { return asked.length },
    get refused() { return refused },
    async reply(agentText: string): Promise<string> {
      asked.push(agentText)
      const said = agentText.toLowerCase()
      const hit = persona.refuses.find(
        (r) => r.cues.some((cue) => said.includes(cue.toLowerCase())),
      )
      // The refusal is checked FIRST. A message that mentions both a fact she
      // has and a thing she refuses is a message whose answer is the refusal,
      // and answering the fact would let a desk talk her into the thing she came
      // in saying no to, which is the case "not for 1,500 over four weeks"
      // exists to hold.
      if (hit) {
        refused.push(hit.what)
        return styled(`no, ${hit.what} is out and that is not something i will change.`)
      }
      const clauses = [...new Set(
        agentText.split(/[?\n]/).flatMap((line) => factsFor(line)),
      )].slice(0, MAX_CLAUSES)
      if (clauses.length === 0) return styled("i don't mind, whatever you think is best.")
      const last = clauses.pop()!
      const sentence = clauses.length === 0 ? last : `${clauses.join(', ')} and ${last}`
      return styled(`${sentence}.`)
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
    + `\n\nREFUSES\n${persona.refuses.map((r) => r.what).join('\n')}`
  return {
    get turns() { return turns },
    // Always empty: see `SimUser.refused`. A model's refusal is prose, and
    // nothing here reads prose back into the persona's own words.
    get refused() { return [] },
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
