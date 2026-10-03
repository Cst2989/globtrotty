/**
 * Every seat that may appear in model_calls.seat (migration 0001 constrains the
 * column to exactly these seven; migration 0018 adds the three Jev seats).
 * Only `driver` is wired in this plan; the rest are declared now so plan 3b
 * adds prompts rather than schema.
 */
export type SeatName =
  | 'front_desk' | 'driver' | 'scout' | 'reviewer' | 'monitor' | 'titler' | 'sim_user'
  | 'intake' | 'rerank' | 'router'

export type Seat = {
  readonly model: string
  /** Opus 5's primary cost/latency lever. Haiku takes no effort parameter. */
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  readonly maxTokens: number
  readonly promptVersion: string
  /**
   * The drift anchor. `response.model` echoes the ALIAS for an aliased model, so
   * a recorded response id reads identically before and after a weights swap.
   * This string is the only record of the configuration we INTENDED, so it
   * encodes model + effort + maxTokens: changing any of them changes the id, and
   * a `group by model_config_id` separates the eras.
   */
  readonly modelConfigId: string
}

const id = (model: string, effort: string | null, maxTokens: number) =>
  `${model}/${effort ?? 'noeffort'}/${maxTokens}`

const seat = (
  model: string,
  effort: Seat['effort'],
  maxTokens: number,
  promptVersion: string,
): Seat => ({ model, effort, maxTokens, promptVersion, modelConfigId: id(model, effort, maxTokens) })

// claude-opus-5 carries no date suffix — appending one 404s.
const OPUS = 'claude-opus-5'
// Plan 5 Task 8 (spec section 4): the driver's seat moves to Sonnet 5 at
// effort medium — same dateless convention as Opus 5, no snapshot to resolve
// to. Opus stays declared below as a config switch, not the default.
const SONNET = 'claude-sonnet-5'
// Haiku 4.5 is the only current model with a real dated snapshot, and it is the
// highest-volume seat, so it is pinned exactly (spec section 7).
const HAIKU = 'claude-haiku-4-5-20251001'
// Plan 5: the Jev decision model. Not a Claude model — it has no effort
// parameter and no output budget (it only ever answers fixed-shape questions).
const JEV = 'jev-latest'

// A prompt file edit is a version bump, always: driver.md gained the Scouts
// section in Task 7 (plan 3c), driver@2 -> driver@3; Task 8 (plan 5) moved the
// seat to Sonnet medium, replaced "When to ask" with "Never ask in free text"
// and added the "Notebook keys" section, so driver@3 -> driver@4.
export const SEATS: Record<SeatName, Seat> = {
  driver:     seat(SONNET, 'medium', 4_000, 'driver@4'),
  reviewer:   seat(OPUS,  'high', 8_000,  'reviewer@1'),
  // Retired (plan 5 Task 6 fix round 1): src/agents/router.ts's Jev classification replaced
  // this seat on the live routing path for every turn. Left declared because model_calls
  // history still references it, and src/monitor/drift.ts / test/driver.live.test.ts still
  // exercise it as a drift canary.
  front_desk: seat(HAIKU, null,   1_024,  'front_desk@1'),
  scout:      seat(HAIKU, null,   2_048,  'scout@1'),
  titler:     seat(HAIKU, null,   256,    'titler@1'),
  monitor:    seat(HAIKU, null,   2_048,  'monitor@1'),
  sim_user:   seat(HAIKU, null,   1_024,  'sim_user@1'),
  intake:     seat(JEV,   null,   0,      'intake@1'),
  rerank:     seat(JEV,   null,   0,      'rerank@1'),
  router:     seat(JEV,   null,   0,      'router@1'),
}
