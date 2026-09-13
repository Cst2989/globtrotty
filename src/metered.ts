import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient } from './client.js'
import { costMicros, usageOf } from './pricing.js'
import type { ModelCallSink } from './repo/model-calls.js'
import { seatNameOf, type Seat } from './seats.js'

/**
 * The one place a model call becomes a row. Every call a turn makes goes
 * through it, so "did this call get recorded?" has one answer instead of one
 * per call site. The exception is src/ask.ts, lesson 1.1's one-shot demo: it
 * predates this file, calls client.create directly, and has no sink.
 *
 * The call is priced on the model we asked for, not the one the response echoed:
 * the price table is keyed by the name we chose, and a response that echoed
 * something unpriced must not silently become free. Both strings are recorded,
 * which is what makes the next test worth writing.
 */
export async function callAndRecord(
  client: ModelClient,
  params: MessageCreateParamsNonStreaming,
  meta: { seat: Seat; promptVersion: string; record?: ModelCallSink; signal?: AbortSignal },
): Promise<Message> {
  const startedMs = Date.now()
  const message = await client.create(params, { signal: meta.signal })
  if (meta.record) {
    const usage = usageOf(message)
    await meta.record({
      seat: seatNameOf(meta.seat),
      seatConfig: meta.seat,
      promptVersion: meta.promptVersion,
      modelRequested: params.model,
      modelReturned: message.model,
      usage,
      // `'5m'`: `callAndRecord`'s callers are `classify`, `extract` and
      // `classifyDesk`, none of which caches, and the params it is handed come
      // from `withSeat` rather than from `buildRequest`.
      costMicros: costMicros(meta.seat.model, usage, '5m'),
      latencyMs: Date.now() - startedMs,
    })
  }
  return message
}
