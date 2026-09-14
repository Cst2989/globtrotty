import { randomUUID } from 'node:crypto'
import { REFS_SCHEMA_VERSION, decidedProposals, loadProposal, recordProposal } from '../src/repo/proposals.js'
import { emptyNotebook } from '../src/notebook.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

describeDb('the refs schema stamp', () => {
  it('stamps a written proposal with REFS_SCHEMA_VERSION, and reads it back', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      const conversationId = c!.id as string
      const proposalId = await recordProposal(sql, {
        conversationId, userId: USER, turnId: null,
        refs: [{ sourceId: 'mock-flight-1', quantity: 1, slot: 'flight' }],
        requirementsSnapshot: emptyNotebook(),
      })
      const proposal = await loadProposal(sql, proposalId, conversationId)
      expect(proposal?.refsSchemaVersion).toBe(REFS_SCHEMA_VERSION)
      // decidedProposals shares the same mapping (toProposal), so it carries
      // the stamp too, not only the single-row reader.
      await sql`update course.proposals set decision = 'accept', decided_at = now() where id = ${proposalId}`
      const [decided] = await decidedProposals(sql, { userId: USER })
      expect(decided?.refsSchemaVersion).toBe(REFS_SCHEMA_VERSION)
      // And the migration's own claim about the rows it did not write: a row
      // from before 0021, written here through raw SQL because `recordProposal`
      // always stamps now, carries the column's default rather than a guess.
      const [pre] = await sql`
        insert into course.proposals (conversation_id, user_id, refs)
        values (${conversationId}, ${USER}, ${sql.json([] as never)})
        returning id`
      const preProposal = await loadProposal(sql, pre!.id as string, conversationId)
      expect(preProposal?.refsSchemaVersion).toBe(1)
    })
  })
})
