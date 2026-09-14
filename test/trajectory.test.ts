import { randomUUID } from 'node:crypto'
import {
  announcedButNeverCalled, countersOf, loadTrace, provenanceRate, questionsBeforeGuesses,
  quotedAmountsIn, type Trace, type TraceCall,
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
    const quoted = [{ amount: real, currency: 'EUR' }, { amount: 412, currency: 'EUR' }]
    const out = provenanceRate(trace({ quoted }), priced)
    expect(out).toEqual({ numerator: 1, denominator: 2 })
  })

  it('refuses to back a euro price with a dollar sign in front of it', async () => {
    const items = await mockSuppliers().hotel.search(STAY)
    const priced = new Map(items.map((i) => [i.sourceId, i]))
    const real = Number(items[0]!.price.minor) / 100
    // The same number, in the wrong currency. This is the retired check's own
    // defect (test/regressions.test.ts names it: whole-unit numbers compared
    // with no currency code beside them), and the replacement must not repeat
    // it inside a docstring that says it does not.
    expect(provenanceRate(trace({ quoted: [{ amount: real, currency: 'USD' }] }), priced))
      .toEqual({ numerator: 0, denominator: 1 })
    expect(provenanceRate(trace({ quoted: [{ amount: real, currency: 'EUR' }] }), priced))
      .toEqual({ numerator: 1, denominator: 1 })
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

  it('stays quiet on an instruction, a request, a quoted ask and a denial', () => {
    // The four sentences the first version of this pattern flagged. Every one
    // of them claims that nothing was done, or asks for something, and a check
    // that reddens on the honest denial is worse than no check: it teaches the
    // desk that saying "I have not checked yet" is what costs it a green row.
    const quiet = [
      'Check the baggage rules and bring your passport',
      'You asked me to check whether your passport is still valid',
      'I have not checked the entry rules for Portugal yet',
      'Please confirm your passport number',
    ]
    expect(announcedButNeverCalled(trace({ replies: quiet }))).toEqual([])
  })

  it('still fires on the claim in every voice a desk writes it in', () => {
    const claims = [
      "I've checked the visa rules for you.",
      'We confirmed the entry requirements with the consulate.',
      'We looked up the visa rules before booking.',
    ]
    expect(announcedButNeverCalled(trace({ replies: claims }))).toHaveLength(3)
  })

  /**
   * The two costs of clearing a claim with the whole conversation's calls,
   * pinned rather than described. Both are documented on
   * `announcedButNeverCalled` and neither is a defect to fix here: closing the
   * first needs a turn id beside each reply, and closing the second needs the
   * check to know every tool that could back a sentence.
   */
  it('misses a claim made before the call that clears it', () => {
    const said = ['I checked the entry rules for Portugal and an EU passport is enough.']
    // The reply is turn 1's and the research call is turn 6's, so the sentence
    // was an invention at the moment it was written and reads as backed now.
    const later = { ...call('research_destination', 0), turnId: 't6' }
    expect(announcedButNeverCalled(trace({ replies: said, calls: [later] }))).toEqual([])
  })

  it('flags a claim the agency backed with anything but research_destination', () => {
    const said = ['I checked the entry rules for Portugal and an EU passport is enough.']
    // One tool clears this check and the desk has others. A fact read back out
    // of course.user_memory reads here exactly like an invention.
    expect(announcedButNeverCalled(trace({ replies: said, calls: [call('search_hotels', 0)] })))
      .toHaveLength(1)
  })
})

describe('reading an amount out of prose', () => {
  it('keeps the currency, so a dollar figure never backs a euro corpus', () => {
    expect(quotedAmountsIn('It is $412 all in.')).toEqual([{ amount: 412, currency: 'USD' }])
    expect(quotedAmountsIn('It is 412 euros all in.')).toEqual([{ amount: 412, currency: 'EUR' }])
  })

  it('reads a marker the redactor knows and the first scanner did not', () => {
    // `redactCurrency` (src/channel.ts) removes ten codes and four symbols from
    // the model's prose. A scanner that knew four of them reported a sterling
    // price as nothing to look at, which is the denominator shrinking in
    // silence: the failure this check exists to make impossible.
    expect(quotedAmountsIn('£412 per night')).toEqual([{ amount: 412, currency: 'GBP' }])
    expect(quotedAmountsIn('1200 SEK per night')).toEqual([{ amount: 1200, currency: 'SEK' }])
  })

  it('parses both spellings of a decimal mark rather than returning NaN', () => {
    // "412,50" is the form `redactCurrency`'s own docstring names, and the first
    // version of this scanner made it NaN, which matches nothing in a corpus and
    // so counted as an invented price for ever.
    expect(quotedAmountsIn('412,50 EUR')).toEqual([{ amount: 412.5, currency: 'EUR' }])
    expect(quotedAmountsIn('412.50 EUR')).toEqual([{ amount: 412.5, currency: 'EUR' }])
    expect(quotedAmountsIn('1,742 EUR')).toEqual([{ amount: 1742, currency: 'EUR' }])
    expect(quotedAmountsIn('1.742,50 EUR')).toEqual([{ amount: 1742.5, currency: 'EUR' }])
    for (const { amount } of quotedAmountsIn('412,50 EUR and 1,742 EUR and 9 GBP')) {
      expect(Number.isFinite(amount)).toBe(true)
    }
  })

  it('reads no amount out of a year, a flight number or a time', () => {
    expect(quotedAmountsIn('flight TP1234 at 07:45 in 2026')).toEqual([])
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
