import { describe, expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { faqAnswer, FAQ_ANSWERS } from '../src/agents/frontDesk.js'
import { readDesk, routeToPlanning, recordFrontLabel } from '../src/repo/conversations.js'

/**
 * Fix round 1: the Haiku front desk (`makeFrontDesk`/`parseFrontVerdict`/`FrontDeskDeps`) is
 * gone — every test here that exercised the model path went with it. What remains: `faqAnswer`'s
 * own code-side keyword matching (the router's `faq` intent reads this, never the model —
 * src/agents/router.ts), and `routeToPlanning`/`recordFrontLabel`'s own fail-closed contract,
 * which is still live code (`src/repo/conversations.ts`) even with nothing left in `src/`
 * calling it on the happy path.
 */
describe('faqAnswer', () => {
  it('matches cancellations, changes and visas', () => {
    expect(faqAnswer('can I cancel my booking?')).toBe(FAQ_ANSWERS.no_cancellations_visas)
    expect(faqAnswer('do you handle visas?')).toBe(FAQ_ANSWERS.no_cancellations_visas)
    expect(faqAnswer('I need to change my flight')).toBe(FAQ_ANSWERS.no_cancellations_visas)
  })

  it('matches payment and booking links', () => {
    expect(faqAnswer('do you take payment?')).toBe(FAQ_ANSWERS.booking_links)
    expect(faqAnswer('how do I pay for this?')).toBe(FAQ_ANSWERS.booking_links)
  })

  it('falls back to "what we do" for anything else, including an empty message', () => {
    expect(faqAnswer('what exactly do you do here?')).toBe(FAQ_ANSWERS.what_we_do)
    expect(faqAnswer('')).toBe(FAQ_ANSWERS.what_we_do)
  })

  it('cancellation/visa wording wins over a payment mention in the same message', () => {
    // FAQ_RULES checks no_cancellations_visas first — a message naming both still gets the
    // more specific answer rather than the generic payment one.
    expect(faqAnswer('I paid already, can I still cancel?')).toBe(FAQ_ANSWERS.no_cancellations_visas)
  })
})

describeDb('front desk repo helpers', () => {
  // M14: routeToPlanning/recordFrontLabel fail closed on zero rows touched,
  // like reserve — a mismatched conversation/user id must be loud, not a
  // silent no-op. Kept independent of the (now-deleted) Haiku front desk:
  // these functions are still live exports of src/repo/conversations.ts.
  it('routeToPlanning and recordFrontLabel throw when the update touches zero rows', async () => {
    await withTestDb(async (sql) => {
      const noSuchId = '00000000-0000-4000-8000-0000000000ff'
      await expect(
        routeToPlanning(sql, { conversationId: noSuchId, userId: noSuchId, title: null, label: 'unclear' }),
      ).rejects.toThrow()
      await expect(
        recordFrontLabel(sql, { conversationId: noSuchId, userId: noSuchId, label: 'unclear' }),
      ).rejects.toThrow()
    })
  })

  it('readDesk still reports a fresh conversation at the front desk', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000f99'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id, desk`
      expect(c!.desk).toBe('front')
      expect(await readDesk(sql, c!.id as string, userId)).toBe('front')
    })
  })
})
