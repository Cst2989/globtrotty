import { randomUUID } from 'node:crypto'
import {
  announcedButNeverCalled, countersOf, loadTrace, provenanceRate, questionsBeforeGuesses,
  type Trace, type TraceCall,
} from '../src/evals/trajectory.js'
import { submitMessage } from '../src/handler.js'
import { claimTurn } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { HotelSearch } from '../src/supplier/types.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()
const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro beachfront', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

const trace = (over: Partial<Trace> = {}): Trace => ({
  turnIds: ['t1'], calls: [], replies: [], sourceIds: new Set(), quoted: [], ...over,
})
const call = (name: string, i: number, questions = name === 'ask_user' ? 1 : 0): TraceCall =>
  ({ name, callId: `s${i}-b0`, turnId: 't1', seq: i, questions })

describe('grading the path', () => {
  it('catches the fare nobody looked up, with its denominator', async () => {
    const items = await mockSuppliers().hotel.search(STAY)
    const priced = new Map(items.map((i) => [i.sourceId, i]))
    const real = Number(items[0]!.price.minor) / 100
    const out = provenanceRate(trace({ quoted: [real, 412] }), priced)
    expect(out).toEqual({ numerator: 1, denominator: 2 })
  })

  it('reports a reply with no amounts as unlooked-at rather than as clean', () => {
    expect(provenanceRate(trace(), new Map())).toEqual({ numerator: 0, denominator: 0 })
  })

  it('catches two searches on a message that stated nothing', () => {
    expect(questionsBeforeGuesses(trace({
      calls: [call('search_hotels', 0), call('search_flights', 1), call('ask_user', 2)],
    }))).toBe(false)
  })

  it('passes a turn that asked first, and one that searched nothing at all', () => {
    expect(questionsBeforeGuesses(trace({ calls: [call('ask_user', 0), call('search_hotels', 1)] }))).toBe(true)
    expect(questionsBeforeGuesses(trace({ calls: [call('ask_user', 0)] }))).toBe(true)
  })

  it('tells the two identical sentences apart by their traces', () => {
    const said = ['I checked the entry rules for Portugal and an EU passport is enough.']
    expect(announcedButNeverCalled(trace({ replies: said }))).toHaveLength(1)
    expect(announcedButNeverCalled(trace({ replies: said, calls: [call('research_destination', 0)] })))
      .toHaveLength(0)
  })

  it('does not fire on a reply that mentions a passport without claiming a check', () => {
    // The pattern has to be narrow enough to live in a scorecard. "Bring your
    // passports" is not a claim that anything was looked up, and a check that
    // flagged it would be a check somebody turns off.
    expect(announcedButNeverCalled(trace({ replies: ['Bring your passports to the airport.'] })))
      .toHaveLength(0)
  })
})

/**
 * The reason `loadTrace` reads `course.model_calls` and not `course.turns.state`,
 * pinned rather than argued.
 *
 * A valid `ask_user` comes back from the driver as a `message` step, and the
 * worker's message branch returns before the transcript append, so the block is
 * in the model's captured reply and in no transcript anywhere. A trace read off
 * the transcript would count zero questions on the one turn that asked one,
 * which is the check `questions_stayed_few` has been making since lesson 6.1.
 */
describeDb('the question a transcript cannot hold', () => {
  it('reads the executed calls, their arity, and the ask_user the turn ended on', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'Somewhere warm?', idempotencyKey: randomUUID(),
      })
      const claim = await claimTurn(sql, submitted.turnId!)
      const block = (name: string, input: unknown = {}) =>
        ({ type: 'tool_use', id: `toolu_${name}`, name, input })
      const responses = [
        // Two blocks in one reply. Parallel tool use is on and the driver
        // answers the FIRST, dropping the sibling, so this response is one
        // executed call and not two.
        { content: [block('search_hotels'), block('search_flights')] },
        // The question that ends the turn, carrying three of them in one call.
        { content: [block('ask_user', { questions: ['When?', 'Where?', 'How much?'] })] },
      ]
      for (const response of responses) {
        await sql`
          insert into course.model_calls
            (conversation_id, user_id, turn_id, seat, prompt_version,
             model_requested, model_returned, response)
          values (${submitted.conversationId}, ${USER}, ${claim!.turnId}, 'driver', 'test',
                  'm', 'm', ${sql.json(response as never)}::jsonb)`
      }
      // The transcript this turn would be resumed from holds none of it.
      const [row] = await sql<{ state: unknown }[]>`
        select state from course.turns where id = ${claim!.turnId}`
      expect(JSON.stringify(row!.state ?? null)).not.toContain('ask_user')

      const loaded = await loadTrace(sql, {
        conversationId: submitted.conversationId, userId: USER, turnIds: [claim!.turnId],
      })
      // The dropped sibling is not a call the agency made.
      expect(loaded.calls.map((c) => c.name)).toEqual(['search_hotels', 'ask_user'])
      expect(loaded.calls[1]!.callId).toBe('toolu_ask_user')
      // Three questions in one call, which is what the ceiling is written about.
      expect(loaded.calls.map((c) => c.questions)).toEqual([0, 3])
      expect(countersOf(loaded, new Map())).toEqual({
        toolCalls: 2, questionsAsked: 3, searchesBeforeFirstQuestion: 1,
        pricesQuoted: 0, unbackedPrices: 0,
      })
      // And the check that reads it now has something true to say.
      expect(questionsBeforeGuesses(loaded)).toBe(false)
    })
  })
})
