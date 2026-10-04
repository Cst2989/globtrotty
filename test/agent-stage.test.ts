/**
 * Polish pass, section 8. "My chat stayed here, very primitive."
 *
 * What she saw: a flight chosen, a list of Tokyo hotels on the right, and in the chat "You asked
 * to refresh prices" (she had not), "Prices refreshed." and the chips `Direct flights only`,
 * `Cheapest first`, `Leave a day earlier`. Every word of it was about a list she had finished
 * with, because every code-written reply picked its copy from WHICH HANDLER was running rather
 * than from where she actually was.
 *
 * `conversationStage` is the fact those replies now read. It is deliberately narrow: proposals
 * only, nothing from a message, so nothing she or a supplier wrote can move it.
 */
import { expect, it } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import {
  chosenFlightMovedTo, conversationStage, nextStepsForList, nextStepsForStage, refreshReplyFor,
} from '../src/agents/stage.js'

const NOW = new Date('2026-09-13T12:00:00Z')

type Seeded = { userId: string; conversationId: string; turnId: string }

async function seed(sql: postgres.Sql, n: string): Promise<Seeded> {
  const userId = `00000000-0000-4000-8000-0000000c20${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${c!.id}, ${userId}, ${'st' + n}, 'running') returning id`
  return { userId, conversationId: c!.id as string, turnId: t!.id as string }
}

/**
 * A proposals row, written straight in. `saveProposal` wants a notebook, a total, a gate round
 * and a prompt version — none of which `conversationStage` reads: it looks at the itinerary's
 * slots and the decision, and nothing else. Writing the row directly is what keeps this test
 * about the thing it is testing.
 */
async function propose(
  sql: postgres.Sql, s: Seeded, slots: ('flight' | 'stay')[], decision: 'accept' | null,
): Promise<void> {
  const itinerary = {
    schemaVersion: 1,
    items: slots.map((slot, i) => ({
      slot, quantity: 1, sourceId: `${slot}-${i}`, supplier: 'mock',
      name: 'X', priceMinor: '10000', currency: 'EUR', priceBasis: 'total',
    })),
  }
  await sql`
    insert into proposals
      (conversation_id, user_id, turn_id, itinerary, itinerary_schema_version,
       requirements_snapshot, total_minor, currency, gate_outcome, review_rounds,
       review_issues, prompt_version, model_config_id, parent_proposal_id, decision, decided_at)
    values (${s.conversationId}, ${s.userId}, ${s.turnId}, ${sql.json(itinerary as never)}, 1,
            ${sql.json({} as never)}, ${'10000'}, ${'EUR'}, ${'approved'}, 0,
            ${sql.array([] as string[])}, ${'test'}, ${'test'}, ${null},
            ${decision}, ${decision === null ? null : NOW})`
}

describeDb('conversationStage', () => {
  it('is flights until a flight is actually accepted', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      expect(await conversationStage(sql, s.conversationId, s.userId)).toBe('flights')
      // Written but not decided: she has not chosen anything yet.
      await propose(sql, s, ['flight'], null)
      expect(await conversationStage(sql, s.conversationId, s.userId)).toBe('flights')
    })
  })

  it('is hotels once the flights-only proposal is accepted', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      await propose(sql, s, ['flight'], 'accept')
      expect(await conversationStage(sql, s.conversationId, s.userId)).toBe('hotels')
    })
  })

  it('is summary once a proposal carries both halves, decided or not', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      await propose(sql, s, ['flight'], 'accept')
      // The combined proposal is deliberately left UNDECIDED — "Get booking links" is the
      // acceptance, not the hotel click (spec section 9) — so an undecided one still counts.
      await propose(sql, s, ['flight', 'stay'], null)
      expect(await conversationStage(sql, s.conversationId, s.userId)).toBe('summary')
    })
  })

  it('reads only this traveller\'s own conversation', async () => {
    await withTestDb(async (sql) => {
      const mine = await seed(sql, '04')
      const theirs = await seed(sql, '05')
      await propose(sql, theirs, ['flight'], 'accept')
      expect(await conversationStage(sql, mine.conversationId, mine.userId)).toBe('flights')
    })
  })
})

it('picks the chips from the stage, and from the list when one is being shown', () => {
  expect(nextStepsForStage('flights')).toBe('flights')
  expect(nextStepsForStage('hotels')).toBe('hotels')
  expect(nextStepsForStage('summary')).toBe('summary')
  // The author's complaint, in one line: flight chips under a list of hotels.
  expect(nextStepsForList('flights', 'hotels')).toBe('hotels')
  expect(nextStepsForList('hotels', 'flights')).toBe('flights')
  expect(nextStepsForList('summary', 'hotels')).toBe('summary')
})

it('says nothing about a flights refresh once the flight is chosen', () => {
  expect(refreshReplyFor('flights', 'flights')).toBe('Prices refreshed.')
  expect(refreshReplyFor('hotels', 'hotels')).toBe('Hotel prices are up to date.')
  // Silent: the row still lands, and the chat is not interrupted to announce it.
  expect(refreshReplyFor('hotels', 'flights')).toBe('')
  expect(refreshReplyFor('summary', 'flights')).toBe('')
  expect(chosenFlightMovedTo('€6,174.00')).toBe('Your chosen flight is now €6,174.00.')
})
