import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A seat is a model plus the settings we give it; every call names a seat, never a model. */
export type Seat = { model: string; effort: Effort | null }

export const SEATS = {
  /** The seat that decides what happens next: strongest model, default effort. */
  driver: { model: 'claude-opus-5', effort: 'high' },
  /** Short answers we can check against her message. Haiku 4.5 takes no effort setting. */
  cheap: { model: 'claude-haiku-4-5-20251001', effort: null },
} as const satisfies Record<string, Seat>

type SeatlessParams = Omit<MessageCreateParamsNonStreaming, 'model'>

/** Writes the seat's model and effort into a request; effort is omitted, not nulled, when the seat has none. */
export function withSeat(seat: Seat, params: SeatlessParams): MessageCreateParamsNonStreaming {
  if (seat.effort === null) return { ...params, model: seat.model }
  return {
    ...params,
    model: seat.model,
    output_config: { ...(params.output_config ?? {}), effort: seat.effort },
  }
}
