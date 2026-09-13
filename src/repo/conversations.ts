import type postgres from 'postgres'
import type { Desk } from '../tools/registry.js'

/**
 * `course.conversations.desk` has existed since migration 0001 with a default of
 * `'planning'` and no reader and no writer. This file is both.
 *
 * The desk is decided once, on the first step of a turn, and remembered, because
 * re-deciding it per step would put a classification call in front of every
 * model call the turn makes and could send step three of a planning conversation
 * to a desk with no tools. The column is on the CONVERSATION rather than on the
 * turn deliberately: a traveller who opens with a visa question and then asks
 * for a trip is re-classified on her next turn, since a new turn's first step
 * runs the classifier again.
 */
export async function readDesk(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<Desk> {
  const rows = await sql<{ desk: string }[]>`
    select desk from course.conversations
     where id = ${conversationId} and user_id = ${userId}`
  const row = rows[0]
  if (!row) throw new Error(`readDesk: conversation ${conversationId} not found for this user`)
  // Anything the column holds that is not a desk we ship reads as planning, for
  // the same reason a parse failure routes there: the front desk has no tools,
  // so guessing it is the one guess that cannot be recovered from inside a turn.
  return row.desk === 'front' ? 'front' : 'planning'
}

export async function writeDesk(
  sql: postgres.Sql, conversationId: string, userId: string, desk: Desk,
): Promise<void> {
  const rows = await sql`
    update course.conversations set desk = ${desk}, updated_at = now()
     where id = ${conversationId} and user_id = ${userId}
    returning id`
  if (rows.length === 0) throw new Error(`writeDesk: wrote no row for ${conversationId}`)
}
