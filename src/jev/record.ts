import type postgres from 'postgres'
import { SEATS } from '../model/seats.js'
import { jevCostMicros, type JevRequest, type JevResponse } from './client.js'

export type JevSeat = 'intake' | 'rerank' | 'router'

/** One model_calls row per Jev call; returns the cost the caller must put on its step's costMicros. */
export async function recordJevCall(sql: postgres.Sql, args: {
  conversationId: string | null; turnId: string | null; userId: string; seat: JevSeat
  request: JevRequest; response: JevResponse
}): Promise<bigint> {
  const seat = SEATS[args.seat]
  const cost = jevCostMicros(args.response.usage.input_tokens)
  await sql`
    insert into model_calls (conversation_id, turn_id, user_id, seat, prompt_version, model_config_id, effort,
      thinking_mode, max_tokens, model, request_id, system_prompt, user_prompt, response, input_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_micros, latency_ms, capture_policy)
    values (${args.conversationId}, ${args.turnId}, ${args.userId}, ${args.seat}, ${seat.promptVersion}, ${seat.modelConfigId}, null,
      null, 0, ${args.response.model}, null, ${JSON.stringify(args.request.questions)}, ${JSON.stringify(args.request.state)},
      ${sql.json(args.response.answers as never)}, ${args.response.usage.input_tokens}, 0, 0, ${args.response.usage.output_tokens},
      ${cost.toString()}, ${args.response.latencyMs}, 'full')`
  return cost
}
