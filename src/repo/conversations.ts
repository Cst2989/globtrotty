import type postgres from 'postgres'
import type { FrontLabel } from '../agents/frontDesk.js'

export type Desk = 'front' | 'planning'

export async function readDesk(sql: postgres.Sql, conversationId: string, userId: string): Promise<Desk> {
  const rows = await sql<{ desk: Desk }[]>`
    select desk from conversations where id = ${conversationId} and user_id = ${userId}`
  if (rows.length === 0) throw new Error(`readDesk: conversation ${conversationId} not found for this user`)
  return rows[0]!.desk
}

/**
 * One statement: desk, label and (optional) title move together, so a crash cannot leave a titled conversation still at the front desk.
 *
 * M14: fails closed, like `reserve` (src/repo/reservation.ts), on zero rows
 * touched — a conversation id/user id pair that matches nothing is a bug
 * upstream (a stale id, a mismatched user), and silently doing nothing would
 * leave the front desk's own belief ("I just routed her to planning") wrong
 * with no signal anywhere that it happened.
 */
export async function routeToPlanning(
  sql: postgres.Sql, args: { conversationId: string; userId: string; title: string | null; label: FrontLabel },
): Promise<void> {
  const rows = await sql`update conversations
               set desk = 'planning', front_label = ${args.label},
                   title = coalesce(${args.title}, title), updated_at = now()
             where id = ${args.conversationId} and user_id = ${args.userId}
            returning id`
  if (rows.length === 0) {
    throw new Error(`routeToPlanning: conversation ${args.conversationId} not found for this user`)
  }
}

/** M14: fails closed on zero rows touched — see routeToPlanning's doc comment. */
export async function recordFrontLabel(
  sql: postgres.Sql, args: { conversationId: string; userId: string; label: FrontLabel },
): Promise<void> {
  const rows = await sql`update conversations set front_label = ${args.label}, updated_at = now()
             where id = ${args.conversationId} and user_id = ${args.userId}
            returning id`
  if (rows.length === 0) {
    throw new Error(`recordFrontLabel: conversation ${args.conversationId} not found for this user`)
  }
}
