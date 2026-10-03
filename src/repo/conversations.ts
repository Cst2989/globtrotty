import type postgres from 'postgres'
import type { FrontLabel } from '../agents/frontDesk.js'
import { parseResults } from '../results.js'

export type Desk = 'front' | 'planning'

export async function readDesk(sql: postgres.Sql, conversationId: string, userId: string): Promise<Desk> {
  const rows = await sql<{ desk: Desk }[]>`
    select desk from conversations where id = ${conversationId} and user_id = ${userId}`
  if (rows.length === 0) throw new Error(`readDesk: conversation ${conversationId} not found for this user`)
  return rows[0]!.desk
}

/**
 * Plan 5: intake's own desk writer, mirroring `routeToPlanning`'s fail-closed contract on zero
 * rows touched — a conversation/user id pair that matches nothing is a bug upstream, and a
 * silent no-op would leave intake believing the desk flipped when it did not. Unlike
 * `routeToPlanning`, this never touches `title`/`front_label`: intake is not the front desk, and
 * has no verdict of either shape to record.
 */
export async function setDesk(
  sql: postgres.Sql, conversationId: string, userId: string, desk: Desk,
): Promise<void> {
  const rows = await sql`update conversations set desk = ${desk}, updated_at = now()
             where id = ${conversationId} and user_id = ${userId}
            returning id`
  if (rows.length === 0) {
    throw new Error(`setDesk: conversation ${conversationId} not found for this user`)
  }
}

/**
 * The most recent `results` row across EVERY conversation this user has had, whose `query.from`
 * is set — i.e. the origin of her last flight search, for intake to default to when she doesn't
 * name one this time. `results`/`choices` rows carry `user_id` directly (same column every other
 * message row has), so this needs no join through `conversations`.
 *
 * Only flight results carry `query.from` (`ResultsContentSchema`'s `query.place` is the hotel
 * shape instead), so no `kind` check is needed beyond that — a hotel row simply never matches.
 * Bounded to the newest 50 `results` rows rather than every one she has ever had: this reads
 * newest-first and returns on the first match, so a bound only matters when she has searched
 * flights 50+ times with `from` absent every time, which is not a case worth an unbounded scan
 * for.
 */
export async function readLastOrigin(sql: postgres.Sql, userId: string): Promise<string | null> {
  const rows = await sql<{ content: string }[]>`
    select content from messages
     where user_id = ${userId} and role = 'results'
     order by created_at desc
     limit 50`
  for (const row of rows) {
    const parsed = parseResults(row.content)
    if (parsed?.query.from) return parsed.query.from
  }
  return null
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
