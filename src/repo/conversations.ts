import type postgres from 'postgres'
import type { FrontLabel } from '../agents/frontDesk.js'

export type Desk = 'front' | 'planning'

export async function readDesk(sql: postgres.Sql, conversationId: string, userId: string): Promise<Desk> {
  const rows = await sql<{ desk: Desk }[]>`
    select desk from conversations where id = ${conversationId} and user_id = ${userId}`
  if (rows.length === 0) throw new Error(`readDesk: conversation ${conversationId} not found for this user`)
  return rows[0]!.desk
}

/** One statement: desk, label and (optional) title move together, so a crash cannot leave a titled conversation still at the front desk. */
export async function routeToPlanning(
  sql: postgres.Sql, args: { conversationId: string; userId: string; title: string | null; label: FrontLabel },
): Promise<void> {
  await sql`update conversations
               set desk = 'planning', front_label = ${args.label},
                   title = coalesce(${args.title}, title), updated_at = now()
             where id = ${args.conversationId} and user_id = ${args.userId}`
}

export async function recordFrontLabel(
  sql: postgres.Sql, args: { conversationId: string; userId: string; label: FrontLabel },
): Promise<void> {
  await sql`update conversations set front_label = ${args.label}, updated_at = now()
             where id = ${args.conversationId} and user_id = ${args.userId}`
}
