import type postgres from 'postgres'

/**
 * What one turn did, in five counters, as `course.turn_labels` (migration 0019)
 * stores them.
 *
 * Every one of them is recomputable from `course.model_calls`,
 * `course.messages` and `course.tool_results` today and from none of them once
 * the ninety day window trims those rows, which is the whole reason the row is
 * written at all.
 */
export type TurnCounters = {
  toolCalls: number
  questionsAsked: number
  searchesBeforeFirstQuestion: number
  pricesQuoted: number
  unbackedPrices: number
}

/**
 * One row per turn, written once, verified through `returning` like every other
 * writer in this directory.
 *
 * `on conflict do nothing` and then a zero-row check would be wrong here: a
 * second label write for one turn means two callers believe they own the
 * turn's end, and swallowing it would hide that. The primary key refuses it and
 * the caller decides what a refusal means.
 */
export async function recordTurnLabels(
  sql: postgres.Sql,
  args: { turnId: string; conversationId: string; userId: string; counters: TurnCounters },
): Promise<void> {
  const c = args.counters
  const rows = await sql`
    insert into course.turn_labels
      (turn_id, conversation_id, user_id, tool_calls, questions_asked,
       searches_before_first_question, prices_quoted, unbacked_prices)
    values (${args.turnId}, ${args.conversationId}, ${args.userId}, ${c.toolCalls},
            ${c.questionsAsked}, ${c.searchesBeforeFirstQuestion}, ${c.pricesQuoted},
            ${c.unbackedPrices})
    returning turn_id`
  if (rows.length === 0) throw new Error(`recordTurnLabels: wrote no row for turn ${args.turnId}`)
}

/**
 * Every labelled turn of one conversation, oldest first.
 *
 * By `seq` and never by `created_at`, for the reason migration 0001 wrote on
 * `course.messages.seq`: every row a test writes shares one transaction
 * timestamp, so that column cannot order anything.
 */
export async function readTurnLabels(
  sql: postgres.Sql, args: { conversationId: string; userId: string },
): Promise<(TurnCounters & { turnId: string })[]> {
  const rows = await sql<Record<string, string>[]>`
    select turn_id, tool_calls, questions_asked, searches_before_first_question,
           prices_quoted, unbacked_prices
      from course.turn_labels
     where conversation_id = ${args.conversationId} and user_id = ${args.userId}
     order by seq`
  return rows.map((r) => ({
    turnId: r.turn_id!,
    toolCalls: Number(r.tool_calls),
    questionsAsked: Number(r.questions_asked),
    searchesBeforeFirstQuestion: Number(r.searches_before_first_question),
    pricesQuoted: Number(r.prices_quoted),
    unbackedPrices: Number(r.unbacked_prices),
  }))
}
