import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { ESCALATION_REASONS } from '../src/notify.js'

const USER = '00000000-0000-4000-8000-00000000a001'

async function seedProposal(sql: any) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning id`
  const [p] = await sql`
    insert into proposals (conversation_id, user_id, itinerary, requirements_snapshot,
                           total_minor, currency, gate_outcome)
    values (${c.id}, ${USER}, ${sql.json({ items: [] })}, ${sql.json({})}, 0, 'EUR', 'approved')
    returning id`
  return { conversationId: c.id as string, proposalId: p.id as string }
}

describeDb('0014 plan 3b schema', () => {
  it('lets a proposal name its parent, and nulls the link when the parent goes', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, proposalId } = await seedProposal(sql)
      const [child] = await sql`
        insert into proposals (conversation_id, user_id, itinerary, requirements_snapshot,
                               total_minor, currency, gate_outcome, parent_proposal_id)
        values (${conversationId}, ${USER}, ${sql.json({ items: [] })}, ${sql.json({})},
                0, 'EUR', 'approved', ${proposalId})
        returning id, parent_proposal_id`
      expect(child!.parent_proposal_id).toBe(proposalId)
      await sql`delete from proposals where id = ${proposalId}`
      const [after] = await sql`select parent_proposal_id from proposals where id = ${child!.id}`
      expect(after!.parent_proposal_id).toBeNull()
    })
  })

  it('records an escalation with a fixed reason and refuses free text', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, proposalId } = await seedProposal(sql)
      const [e] = await sql`
        insert into escalations (conversation_id, user_id, proposal_id, reason)
        values (${conversationId}, ${USER}, ${proposalId}, 'price_moved')
        returning id, notified_at`
      expect(e!.id).toBeTruthy()
      expect(e!.notified_at).toBeNull()
      await expect(sql`
        insert into escalations (conversation_id, user_id, reason)
        values (${conversationId}, ${USER}, 'the hotel smelled')`)
        .rejects.toThrow(/check constraint/i)
    })
  })

  // M5: pins the TS enum and migration 0014's check constraint to each other —
  // a reason added to one without the other would otherwise surface only as a
  // runtime insert failure in production, on whichever side lagged.
  it('accepts every ESCALATION_REASONS value and rejects one outside it', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seedProposal(sql)
      for (const reason of ESCALATION_REASONS) {
        const [e] = await sql`
          insert into escalations (conversation_id, user_id, reason)
          values (${conversationId}, ${USER}, ${reason}) returning id`
        expect(e!.id).toBeTruthy()
      }
      await expect(sql`
        insert into escalations (conversation_id, user_id, reason)
        values (${conversationId}, ${USER}, 'not_a_real_reason')`)
        .rejects.toThrow(/check constraint/i)
    })
  })

  it('refuses an escalation whose conversation belongs to another user', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await seedProposal(sql)
      await expect(sql`
        insert into escalations (conversation_id, user_id, reason)
        values (${conversationId}, '00000000-0000-4000-8000-00000000a002', 'safety')`)
        .rejects.toThrow(/foreign key/i)
    })
  })
})
