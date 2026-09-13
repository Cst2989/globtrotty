import type postgres from 'postgres'
import type { Usage } from '../pricing.js'
import type { Seat, SeatName } from '../seats.js'

/** Everything one model call is worth recording. */
export type CallFacts = {
  seat: SeatName
  /** The seat's own settings, so the row records the configuration we intended. */
  seatConfig: Seat
  promptVersion: string
  /** The model string we sent. */
  modelRequested: string
  /** The model string the API echoed back on the response. */
  modelReturned: string
  usage: Usage
  costMicros: bigint
  latencyMs: number
}

/** Who the call was for. Both ids are null when a call runs outside a turn. */
export type TurnContext = {
  userId: string
  conversationId: string | null
  turnId: string | null
}

export type ModelCallSink = (facts: CallFacts) => Promise<void>

/** Writes one row per call. One insert, no transaction: a row is a whole fact. */
export function pgSink(sql: postgres.Sql, ctx: TurnContext): ModelCallSink {
  return async (facts) => {
    try {
      await sql`insert into course.model_calls (
        conversation_id, turn_id, user_id, seat, prompt_version,
        model_requested, model_returned,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
        cost_micros, latency_ms,
        effort, max_tokens, model_config_id
      ) values (
        ${ctx.conversationId}, ${ctx.turnId}, ${ctx.userId}, ${facts.seat}, ${facts.promptVersion},
        ${facts.modelRequested}, ${facts.modelReturned},
        ${facts.usage.input_tokens}, ${facts.usage.cache_creation_input_tokens},
        ${facts.usage.cache_read_input_tokens}, ${facts.usage.output_tokens},
        ${facts.costMicros.toString()}, ${facts.latencyMs},
        ${facts.seatConfig.effort}, ${facts.seatConfig.maxTokens}, ${facts.seatConfig.modelConfigId}
      )`
    } catch (err) {
      // The call already happened and she already paid for it: a row that
      // fails to write must not take a finished turn down with it. A lost row
      // is cheaper than a lost turn, and this is still logged with the turn id
      // so an operator can find what broke rather than the loss being silent.
      console.error(`model_calls insert failed for turn ${ctx.turnId}`, err)
    }
  }
}

/** The same sink, in memory, for tests that have no database. */
export function memorySink(): ModelCallSink & { calls: CallFacts[] } {
  const calls: CallFacts[] = []
  const sink = (async (facts: CallFacts) => { calls.push(facts) }) as ModelCallSink & { calls: CallFacts[] }
  sink.calls = calls
  return sink
}
