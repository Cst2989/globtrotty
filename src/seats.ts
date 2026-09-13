import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A seat is a model plus the settings we give it; every call names a seat, never a model. */
export type Seat = {
  readonly model: string
  readonly effort: Effort | null
  /**
   * The output ceiling, on the seat rather than at the call site. Three call
   * sites each own a number today and none of them asks the seat: `toolLoop`
   * hardcodes `max_tokens: 8000` for whatever seat it is handed (src/loop.ts),
   * `classify` asks for 64 and `extract` for 400. Nothing ties any of the three
   * to the seat that will be billed for them, so a reservation computed before
   * a call could only guess at the output it was bounding. It is a property of
   * the seat because the reservation (src/repo/reservation.ts) bounds output at
   * exactly this number.
   */
  readonly maxTokens: number
  /**
   * The drift anchor. `response.model` echoes the ALIAS for an aliased model,
   * and `claude-opus-5` is alias only, so a recorded response reads identically
   * before and after a weights swap and a string comparison detects nothing.
   * This string is the only record of the configuration we INTENDED, so it
   * encodes model plus effort plus maxTokens: changing any of them changes the
   * id, and `group by model_config_id` separates the eras. Lesson 5.6's canary
   * is pinned against it.
   */
  readonly modelConfigId: string
}

const configId = (model: string, effort: Effort | null, maxTokens: number): string =>
  `${model}/${effort ?? 'noeffort'}/${maxTokens}`

const seat = (model: string, effort: Effort | null, maxTokens: number): Seat =>
  ({ model, effort, maxTokens, modelConfigId: configId(model, effort, maxTokens) })

// claude-opus-5 carries no date suffix: appending one 404s.
const OPUS = 'claude-opus-5'
// Haiku 4.5 is the only current model with a real dated snapshot, and it is the
// highest volume seat, so it is pinned exactly (SPEC section 7).
const HAIKU = 'claude-haiku-4-5-20251001'

export const SEATS = {
  /** The seat that decides what happens next: strongest model, high effort. */
  driver: seat(OPUS, 'high', 16_000),
  /**
   * Short answers we can check against her message: classify and extract. Haiku
   * 4.5 takes no effort setting. The name is kept rather than renamed to main's
   * `front_desk`, because `cheap` is already written into course.model_calls
   * rows and renaming a value a row carries loses the ability to ask what those
   * rows were. Lesson 5.3 added `front_desk` beside it, below.
   */
  cheap: seat(HAIKU, null, 1_024),
  /**
   * The desk that answers a factual question in three sentences, and the seat
   * that decides which desk she reaches. Haiku 4.5 takes no effort setting.
   * Added beside `cheap` rather than replacing it: `cheap` is the name lesson
   * 1.2 gave the Haiku seat, rows in course.model_calls carry it, and
   * `classify` and `extract` still use it inside `turn()`. The names differ so
   * that a query can tell a routing call from the `classify` and `extract` calls
   * inside `turn()`, the one-process path modules 1 and 2 built and
   * `test/conversation.test.ts` still replays.
   */
  front_desk: seat(HAIKU, null, 1_024),
  /**
   * A worker that reads one city's search results and hands back prose. Haiku,
   * because the job is summarising and not deciding, and 2048 tokens because a
   * brief that runs longer than that is a brief the driver has to read in full
   * anyway, which is the cost this seat exists to avoid.
   */
  scout: seat(HAIKU, null, 2_048),
  /**
   * The seat that reads what a finished turn did and says whether it looks
   * wrong. Haiku, because it decides nothing: `runMonitor` (src/monitor.ts)
   * alarms into a log and can never fail a turn, so the cheap seat is not a
   * saving made against correctness. 2048 tokens, the scout's number, because
   * its answer is one sentence and its input is a JSON summary of one turn.
   *
   * No migration: `monitor` is a name `0014`'s `model_calls_seat_check` already
   * accepts, for the reason lesson 5.3 established for `front_desk` and 5.4 for
   * `scout`. `test/schema.test.ts` walks every SeatName against that constraint,
   * so this line is checked rather than assumed.
   */
  monitor: seat(HAIKU, null, 2_048),
} as const satisfies Record<string, Seat>

export type SeatName = keyof typeof SEATS

/**
 * The seat a call was made from, as a name a row can hold. Matches on the
 * seat's own identity, never on its model string: two seats could share a
 * model with different settings, and a lookup keyed on the model alone would
 * label both calls with whichever name happened to be checked first.
 */
export function seatNameOf(seat: Seat): SeatName {
  const found = (Object.keys(SEATS) as SeatName[]).find((name) => SEATS[name] === seat)
  if (!found) throw new Error(`No seat named for model ${seat.model}`)
  return found
}

type SeatlessParams = Omit<MessageCreateParamsNonStreaming, 'model'>

/**
 * Writes the seat's model and effort into a request; effort is omitted, not
 * nulled, when the seat has none. Still used by `classify` and `extract`, which
 * call the SDK's typed client directly. The driver assembles its request through
 * `buildRequest` (src/model/client.ts) instead, because that request carries
 * fields the SDK's own types do not know about.
 */
export function withSeat(seat: Seat, params: SeatlessParams): MessageCreateParamsNonStreaming {
  if (seat.effort === null) return { ...params, model: seat.model }
  return {
    ...params,
    model: seat.model,
    output_config: { ...(params.output_config ?? {}), effort: seat.effort },
  }
}
