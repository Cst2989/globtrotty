import type postgres from 'postgres'
import type { Desk } from '../tools/registry.js'

/**
 * `course.conversations.desk` has existed since migration 0001 with a default of
 * `'planning'` and no reader and no writer. This file is both.
 *
 * The desk is decided once per TURN and remembered, because re-deciding it per
 * step would put a classification call in front of every model call the turn
 * makes and could send step three of a planning conversation to a desk with no
 * tools. The column is on the CONVERSATION rather than on the turn deliberately:
 * a traveller who opens with a visa question and then asks for a trip is
 * re-classified on her next turn, since a new turn has no decision of its own
 * yet.
 */
export type DeskDecision = {
  desk: Desk
  /** What the routing call cost, read back off its row rather than recomputed. */
  costMicros: bigint
}

/**
 * The decision this TURN has already taken, or null when it has not taken one.
 *
 * Two facts in one statement, because the column alone cannot answer the
 * question. `desk` is `not null default 'planning'` (migration 0001), so a row
 * reading `'planning'` is indistinguishable from a row nobody has written, and a
 * reader that trusted it would never classify anything. The turn's own
 * `front_desk` row in `course.model_calls` is the fact that separates them: it
 * exists exactly when this turn has paid for a classification.
 *
 * That makes an observability row load-bearing, which is worth being explicit
 * about. `pgSink` swallows its own failures by design, so a lost row here does
 * not break a turn: it costs one extra classification on the next attempt, which
 * is precisely the behaviour this reader exists to improve on. The failure mode
 * degrades to the old one rather than to a wrong answer.
 *
 * The earliest `front_desk` row is the routing call's. On a front-desk turn the
 * ANSWER is recorded on the same seat, so `limit 1` over `seq` is what picks the
 * call that decided the desk out of the calls that followed it. `seq` and not
 * `created_at`: every row a test writes shares one transaction timestamp.
 */
export async function readDeskDecision(
  sql: postgres.Sql, conversationId: string, userId: string, turnId: string,
): Promise<DeskDecision | null> {
  const rows = await sql<{ desk: string; routing_cost: string | null }[]>`
    select c.desk,
           (select m.cost_micros from course.model_calls m
             where m.turn_id = ${turnId} and m.user_id = ${userId} and m.seat = 'front_desk'
             order by m.seq limit 1) as routing_cost
      from course.conversations c
     where c.id = ${conversationId} and c.user_id = ${userId}`
  const row = rows[0]
  if (!row) throw new Error(`readDeskDecision: conversation ${conversationId} not found for this user`)
  if (row.routing_cost === null) return null
  // Anything the column holds that is not a desk we ship reads as planning, for
  // the same reason a parse failure routes there: the front desk has no tools,
  // so guessing it is the one guess that cannot be recovered from inside a turn.
  return {
    desk: row.desk === 'front' ? 'front' : 'planning',
    costMicros: BigInt(row.routing_cost),
  }
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
