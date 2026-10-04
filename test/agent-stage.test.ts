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
import { describe, expect, it } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import {
  chosenFlightMovedTo, conversationStage, filterReply, hotelsFoundReply, nextStepsForList,
  nextStepsForStage, refreshReplyFor, stageNote,
} from '../src/agents/stage.js'
import { money } from '../src/money.js'
import type { SupplierItem } from '../src/supplier/types.js'

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

/*
 * Section 8c. "Nice choice. Here are hotels in Tokyo for 20 Nov to 6 Dec, 16 nights, two adults."
 * is a receipt for our own search: every word of it is already in the summary bar above the
 * list, and it left her with a blank composer in front of eighteen cards.
 */
describe('hotelsFoundReply', () => {
  function stay(name: string, propertyType: 'hotel' | 'rental', distanceKm: number | null): SupplierItem {
    return {
      sourceId: name, supplier: 'searchapi', kind: 'hotel', name,
      price: money(100_00n, 'EUR'), priceBasis: 'total',
      fetchedAt: new Date('2026-10-04T12:00:00Z'), ttlSeconds: 86_400, bookingUrl: null,
      detail: {
        kind: 'hotel', checkIn: '2026-11-20', checkOut: '2026-12-06', nights: 16, adults: 2,
        rating: null, reviews: null, stars: null, propertyType, coordinates: null, distanceKm,
        images: [], amenities: [], essentials: [], nearby: [], pricePerNightMinor: null,
        offerSource: null, locationRating: null,
      },
    } as SupplierItem
  }

  it('says what is in the list and asks the next question', () => {
    expect(hotelsFoundReply('Tokyo', [
      stay('Hotel Gracery', 'hotel', 2.4),
      stay('Park Hyatt', 'hotel', 1.1),
      stay('A flat in Shibuya', 'rental', 3.8),
    ])).toBe(
      'I found 3 places in Tokyo for those dates. 2 are hotels, 1 is a rental; '
      + 'the closest to the centre is Park Hyatt at 1.1 km. '
      + 'Pick one, or tell me what matters: area, budget, breakfast.',
    )
  })

  it('never ends a sentence on a semicolon when one half is missing', () => {
    const allHotels = hotelsFoundReply('Tokyo', [stay('A', 'hotel', 2), stay('B', 'hotel', 4)])!
    expect(allHotels).toContain('The closest to the centre is A at 2.0 km.')
    expect(allHotels).not.toContain(';')
    const unplaced = hotelsFoundReply('Tokyo', [stay('A', 'hotel', null), stay('B', 'rental', null)])!
    expect(unplaced).toBe(
      'I found 2 places in Tokyo for those dates. 1 is a hotel, 1 is a rental. '
      + 'Pick one, or tell me what matters: area, budget, breakfast.',
    )
  })

  it('leaves out a distance no traveller would call close', () => {
    // The mock supplier places its stays nowhere in particular, and a confident sentence about
    // a hotel 11,000 km from Tokyo is worse than no sentence.
    expect(hotelsFoundReply('Tokyo', [stay('Far', 'hotel', 11_271)])!)
      .not.toContain('closest to the centre')
  })

  it('has nothing to say about an empty list', () => {
    expect(hotelsFoundReply('Tokyo', [])).toBeNull()
  })
})

it('names the cheapest of what a filter left, and nothing when it left nothing', () => {
  expect(filterReply(2, 3, 'nonstop', { name: 'Qatar Airways', price: '€845.00' }))
    .toBe('Showing 2 of 3: nonstop. The cheapest is Qatar Airways at €845.00.')
  expect(filterReply(0, 3, 'nonstop', null)).toBe('Showing 0 of 3: nonstop.')
})

it('tells the driver where the trip is, in one line', () => {
  expect(stageNote('flights')).toBe('Stage: flights, nothing chosen yet.')
  expect(stageNote('hotels')).toBe('Stage: hotels, flight chosen.')
  expect(stageNote('summary')).toBe('Stage: summary, flight and stay both chosen.')
})
