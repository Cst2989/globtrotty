import { randomUUID } from 'node:crypto'
import { replayGates } from '../src/evals/replay.js'
import { checkBudget, checkTotals } from '../src/gates/checks.js'
import { constraintsFromNotebook } from '../src/gates/notebookConstraints.js'
import { proposalRunner } from '../src/gates/runner.js'
import { money } from '../src/money.js'
import { applyRequirementsPatch, loadNotebook } from '../src/repo/notebook.js'
import { recordResults } from '../src/repo/toolResults.js'
import { claimTurn } from '../src/repo/turns.js'
import { submitMessage } from '../src/handler.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { HotelSearch } from '../src/supplier/types.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()
const TODAY_ISO = '2026-08-29'
const NOW = new Date('2026-08-29T10:00:00Z')
const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

describeDb('replaying a gate against the notebook it was judged with', () => {
  it('refuses on Thursday the offer production refused on Tuesday', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'A week in Faro.', idempotencyKey: randomUUID(),
      })
      const conversationId = submitted.conversationId
      const claim = await claimTurn(sql, submitted.turnId!)
      // The supplier's clock is NOW's, so `checkFreshness` has nothing to say
      // and the only gate that can speak here is the one the lesson is about.
      const items = await mockSuppliers({ hotel: { now: () => NOW } }).hotel.search(STAY)
      await recordResults(sql, claim!, { params: STAY, items })
      const cheapest = items.reduce((a, b) => (a.price.minor < b.price.minor ? a : b))
      const refs = [{ sourceId: cheapest.sourceId, quantity: 1, slot: 'stay' }]

      // Tuesday. She has said 750 euros, and this stay is inside it.
      await applyRequirementsPatch(sql, {
        conversationId, userId: USER, at: '2026-08-25T09:00:00Z', source: 'user',
        patch: { budget: { minor: '75000', currency: 'EUR' }, month: 'September', nights: 7 },
      })
      const tuesdayNb = await loadNotebook(sql, conversationId, USER)
      const run = proposalRunner(
        sql,
        {
          conversationId, userId: USER, turnId: claim!.turnId,
          notebook: constraintsFromNotebook(tuesdayNb, TODAY_ISO),
          snapshot: tuesdayNb,
          now: () => NOW,
        },
        async () => ({ content: 'not reached', isError: true }),
      )
      const approved = await run('propose_itinerary', { refs }, 's0-b0')
      const proposalId = (JSON.parse(approved.content) as { proposalId: string }).proposalId

      // Wednesday. She changes her mind, through the one writer there is. This
      // patch LOWERS the budget rather than raising it: `applyRequirements`
      // refuses a tool-sourced relaxation, this one is hers, and a lowering is
      // what makes the live replay fail while the snapshot replay passes. Same
      // asymmetry the lesson opened on, pointed the other way.
      await applyRequirementsPatch(sql, {
        conversationId, userId: USER, at: '2026-08-26T09:00:00Z', source: 'user',
        patch: { budget: { minor: '1', currency: 'EUR' } },
      })

      // Thursday. Against the snapshot, the verdict is Tuesday's.
      const snapshot = await replayGates(sql, {
        proposalId, conversationId, userId: USER, now: NOW, today: TODAY_ISO,
      })
      expect(snapshot.outcome.ok).toBe(true)
      // Against the live notebook, which is what lesson 6.2 opened on, it is not.
      const live = await replayGates(sql, {
        proposalId, conversationId, userId: USER, now: NOW, today: TODAY_ISO, against: 'live',
      })
      expect(live.outcome.ok).toBe(false)

      // And the replay's rows name the proposal they judged, which no row this
      // branch has ever written did.
      const rows = await sql<{ proposal_id: string | null; round: number }[]>`
        select proposal_id, round from course.gate_results
         where conversation_id = ${conversationId} order by seq`
      expect(rows.some((r) => r.proposal_id === null && r.round === 0)).toBe(true)
      expect(rows.filter((r) => r.proposal_id === proposalId).every((r) => r.round === 1)).toBe(true)
    })
  })

  it('refuses a proposal written before the column existed rather than guessing', async () => {
    await withTestDb(async (sql) => {
      // The shape every pre-0018 row has, written here through raw SQL because
      // `recordProposal` cannot produce it any more: the field is required and
      // has no default, which is the whole reason it is required.
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      const conversationId = c!.id as string
      const [p] = await sql`
        insert into course.proposals (conversation_id, user_id, refs)
        values (${conversationId}, ${USER}, ${sql.json([] as never)})
        returning id`
      await expect(replayGates(sql, {
        proposalId: p!.id as string, conversationId, userId: USER, now: NOW, today: TODAY_ISO,
      })).rejects.toThrow(/no requirements snapshot/)
      // Nothing was judged, so nothing was recorded. A row here would be a
      // verdict reached against a notebook nobody has.
      expect(await sql`select 1 from course.gate_results where conversation_id = ${conversationId}`)
        .toHaveLength(0)
    })
  })
})

describe('the floor, which is already built', () => {
  it('runs production checks offline, with no database and no model', async () => {
    // The identity this lesson is built on: these are not eval versions of the
    // gates, they are the gates. `checkTotals` and `checkBudget` are imported
    // from src/gates/checks.ts, the file src/gates/pipeline.ts imports.
    const items = await mockSuppliers().hotel.search(STAY)
    const rehydrated = items.map((item) => ({
      ref: { sourceId: item.sourceId, quantity: 1, slot: 'stay' }, item, lineTotal: item.price,
    }))
    const totals = checkTotals(rehydrated, 'EUR')
    expect(checkBudget(rehydrated, totals, money(1n, 'EUR'))).toHaveLength(1)
  })
})
