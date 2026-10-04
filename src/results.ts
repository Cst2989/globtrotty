import { z } from 'zod'
import { maskIdChars, maskControlChars, maskUntrustedText } from './sanitize.js'
import { isKnownVerdictLabel } from './intake/verdicts.js'
import { AMENITY_KEYS } from './intake/amenities.js'
import type { Cabin, Assumption } from './intake/brief.js'
import type { AvoidRegion } from './intake/regions.js'

/**
 * `results` and `choices` rows (plan 5): two more `messages.role` values
 * alongside `action` (src/actions.ts), written by our own code — never the
 * model, never the traveller — as a `messages` row whose `content` is this
 * module's JSON. `src/worker.ts`'s `loop()` hydrates each into a `system`
 * message via the two render functions below (see `src/engine.ts`'s
 * `LoopMessage` doc comment for why that role exists at all), and also
 * writes them as step "attachments" right after an agent `message`/`park`
 * row — see `AgentStep` in `src/worker.ts`.
 *
 * Same trust-boundary instinct as the operator channel: what reaches the
 * model is built entirely from this module's fixed template fragments plus
 * the payload's own ids/enums — a traveller cannot forge one by typing JSON
 * into the chat box because the `results`/`choices` roles are never written
 * from her message, and a supplier id is always run through `maskIdChars`
 * before it lands in a rendered note.
 */

// `Cabin` and `Assumption` are src/intake/brief.ts's (Task 3, landed
// concurrently) — re-exported here rather than duplicated, since every other
// interface in this module (`ResultsContent`, below) refers to them by these
// same names.
export type { Cabin, Assumption }

/**
 * What the filter rail (and a typed "only direct flights") narrows the stored results by. One
 * type, three implementations that MUST agree: `applyFilter` (src/intake/filter.ts, over
 * `StoredItem`), `applyFilterLite` (web/filters.ts, over `ResultItemLite`) and this schema. A
 * change to any field belongs in all three in the same commit.
 *
 * `minCabinBags`/`minCheckedBags`/`minRating` are results UI pass 2 (D). The rail is what sets
 * them today, but they live here rather than in the pane's own state so a typed "with a checked
 * bag" or "only 4 star hotels" can reach the same code later without a second notion of what a
 * filter is — the mistake the final review's I3 was made of.
 */
export type Filter = {
  nonstop?: boolean
  maxStops?: number
  departure?: 'morning' | 'afternoon' | 'evening'
  maxPriceMinor?: string
  airlines?: string[]
  /** Hide a flight including fewer than this many cabin bags. Flights only. */
  minCabinBags?: number
  /** Hide a flight including fewer than this many checked bags. Flights only. */
  minCheckedBags?: number
  /** Hide a stay rated below this, and one with no rating at all. Hotels only. */
  minRating?: number
  /**
   * Hotels pass, section 4. Keep only stays whose hotel class is one of these (3, 4 or 5 stars,
   * multi-select). A stay with NO class is excluded whenever this is set, the same rule and the
   * same reason as `minRating`: "4 stars and up" is a claim about the place, and an unclassified
   * one has not made it.
   */
  stars?: number[]
  /** Keep only hotels, or only rentals. A property of neither type is excluded either way. */
  propertyType?: 'hotel' | 'rental'
  /**
   * Keep only stays carrying every one of these amenities, by the keys in
   * `src/intake/amenities.ts` — never a supplier's own label, which is exactly what that table
   * exists to stop both filter implementations from matching on.
   */
  amenities?: string[]
  /** Keep only stays within `NEAR_CENTRE_KM` of the city centre; one with no distance is excluded. */
  nearCentre?: boolean
  /**
   * The bug this filter exists for: "I don't want to stop in China or the Middle East" used to
   * classify as `filter` and change nothing, because no dimension above named a connection's own
   * country. Exclude an itinerary when ANY leg's via airport is in one of these ISO 3166-1
   * alpha-2 countries. Flights only; a hotel item has no leg to judge this against, so it passes
   * through untouched (same posture as `nonstop`/`airlines`). Capped at 10 — well past anything
   * a typed message or the filter bar's own checklist would ever set at once.
   */
  avoidCountries?: string[]
  /**
   * Same exclusion as `avoidCountries`, by the ten buckets `src/intake/regions.ts` defines
   * (`AvoidRegion`) rather than a single country — "the Middle East" or "China" instead of
   * naming every member country by hand. A via airport excludes the item when its OWN country's
   * bucket (`regionOfCountry`) is in this list, or when its country is directly in
   * `avoidCountries` — either is enough, and an itinerary can be excluded by both at once (she
   * can say "not China or Japan" in one sentence).
   */
  avoidRegions?: AvoidRegion[]
}

/**
 * Which LIST a filter is about, or `null` for one whose fields apply to either (a price cap).
 *
 * Trip-stage pass, found by the browser harness. A typed "only direct flights" at the hotels
 * stage was applied to the newest row, which was the HOTELS one, and the desk answered
 * "Showing 19 of 19: nonstop" about a list of Tokyo hotels — the same fault, in the other
 * direction, as the `Direct flights only` chips the polish pass took off a hotels reply. A
 * filter names its own kind; nothing about where she happens to be looking changes it.
 *
 * Pure, so `test/web-filters.test.ts` pins every field without a database.
 */
export function filterKind(filter: Filter): 'flights' | 'hotels' | null {
  const flights = filter.nonstop !== undefined
    || filter.maxStops !== undefined
    || filter.departure !== undefined
    || filter.airlines !== undefined
    || filter.minCabinBags !== undefined
    || filter.minCheckedBags !== undefined
  const hotels = filter.minRating !== undefined
    || filter.stars !== undefined
    || filter.propertyType !== undefined
    || filter.amenities !== undefined
    || filter.nearCentre !== undefined
  // Both at once is a filter Jev built out of two different lists' vocabularies, which is a
  // guess about a screen that does not exist. The row she is looking at decides it.
  if (flights === hotels) return null
  return flights ? 'flights' : 'hotels'
}

export type ResultsContent = {
  kind: 'flights' | 'hotels'
  query: {
    from?: string
    to?: string
    place?: string
    /**
     * The destination's ISO 3166-1 alpha-2 country code, on a hotels row only (the hotels
     * pass). `handleChooseFlight` writes it so `handleRefresh` can rebuild the IDENTICAL
     * supplier query — `hotels in Tokyo, Japan` with `gl=jp` — off the stored row rather than
     * re-deriving its own, which is how the two drifted apart before.
     */
    country?: string
    outbound: string
    inbound: string | null
    adults: number
    cabin?: Cabin
  }
  sourceIds: string[]
  assumptions: Assumption[]
  filter?: Filter
  /**
   * Pass 3: this row is `handleRefresh`'s (src/agents/refresh.ts), a re-run of
   * a search she already had rather than a new one. Only the thread marker
   * reads it (`describeResultsForUi`, web/data.ts: "Prices refreshed · 10
   * flights"); the pane renders a refreshed row exactly like any other,
   * because it IS one.
   */
  refreshed?: boolean
  /**
   * Hotels pass, section 7: Jev's own check of each result against what she asked for, keyed on
   * `sourceId`. `matches` are FACTS this office computed (`matchesFor`, src/intake/rank.ts);
   * `issues` are the findings Jev returned above the gate, each turned into one of
   * `ISSUE_LABELS`'s fixed sentences. Every string in both lists comes from that module's own
   * vocabulary and is re-checked here by `VerdictLabelSchema`.
   *
   * ABSENT means unchecked, not clean: the Jev call failed, or the row predates this field, or
   * the item sat past `MAX_SCORED` and was never shown to Jev. The pane renders an unchecked
   * list with a muted line saying so rather than implying everything passed.
   */
  verdicts?: Record<string, { matches: string[]; issues: string[] }>
}

export type ChoicesContent = {
  questionId: string
  question: string
  options: { id: string; label: string }[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const CabinSchema = z.enum(['economy', 'premium_economy', 'business', 'first'])

const AssumptionSchema = z.strictObject({
  field: z.string().min(1).max(64),
  value: z.string().min(1).max(256),
  reason: z.enum(['unstated', 'defaulted', 'year']),
})

/**
 * Section 7's fixed vocabulary, enforced at the boundary rather than trusted.
 *
 * `isKnownVerdictLabel` (src/intake/rank.ts) owns the list; this is the same check applied where
 * a `results` row is parsed, so a verdict string that no version of that module could have
 * produced cannot reach the pane whatever wrote the row. The same instinct as `strictObject`
 * everywhere else in this file: the boundary is where a surprise is refused.
 */
const VerdictLabelSchema = z.string().min(1).max(64).refine(isKnownVerdictLabel, {
  message: 'not a known verdict label',
})

const FilterSchema = z.strictObject({
  nonstop: z.boolean().optional(),
  maxStops: z.number().int().min(0).max(10).optional(),
  departure: z.enum(['morning', 'afternoon', 'evening']).optional(),
  maxPriceMinor: z.string().regex(/^\d{1,12}$/).optional(),
  // M5: 8 characters was an IATA-code-shaped guess. `matchAirlines`
  // (src/agents/router.ts) builds this from the carrier strings a SUPPLIER
  // put in the corpus, so a longer one — matched as a whole word against her
  // message, then written here — used to fail `ResultsContentSchema.parse`
  // inside `buildAttachmentRows` and fail the turn. 64 is the same cap every
  // other supplier-origin short string in this file carries, and
  // `maskUntrustedText` is applied because this IS supplier-authored text
  // (the same reason `describeFilter` masks each entry before rendering it);
  // the schema is the boundary, so the masking belongs here too.
  airlines: z.array(z.string().min(1).max(64).transform(maskUntrustedText)).optional(),
  // Bounded well above anything a fare includes (two checked bags is the top of the rail's own
  // stepper) for the same reason every other number here is bounded: this is a value that can
  // reach the model through `renderResultsNote`'s sibling renderers, so the schema is where its
  // range is settled rather than the UI that happens to write it today.
  minCabinBags: z.number().int().min(0).max(9).optional(),
  minCheckedBags: z.number().int().min(0).max(9).optional(),
  minRating: z.number().min(0).max(5).optional(),
  // Hotel class is 1-5 by definition; the rail offers 3, 4 and 5. Bounded here rather than in
  // the bar for the same reason every other number in this schema is: a typed filter can reach
  // the same field without going through any UI.
  stars: z.array(z.number().int().min(1).max(5)).max(5).optional(),
  propertyType: z.enum(['hotel', 'rental']).optional(),
  // Our OWN keys, never a supplier's label — `src/intake/amenities.ts` owns the list, and this
  // refuses anything outside it at the boundary.
  amenities: z.array(z.string().refine((k) => AMENITY_KEYS.includes(k))).max(8).optional(),
  nearCentre: z.boolean().optional(),
  // Exactly two letters, same shape as `query.country` above — an ISO 3166-1 alpha-2 code,
  // never a free-form place name. Capped at 10: `routeMessage`'s own alias match
  // (src/agents/router.ts) never produces more, and the filter bar's checklist is bounded by
  // how many countries actually appear among the via airports of one results row.
  avoidCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(10).optional(),
  // `src/intake/regions.ts`'s own ten-member vocabulary — duplicated here as literal strings
  // (rather than imported) for the same reason `CabinSchema` duplicates `Cabin`'s own members:
  // the schema is the boundary, and it is the one place a surprise is refused whatever module
  // produced the value.
  avoidRegions: z.array(z.enum([
    'china', 'middle_east', 'russia', 'usa',
    'europe', 'north_america', 'asia', 'oceania', 'africa', 'south_america',
  ])).max(10).optional(),
})

/**
 * `z.strictObject` at every level, same reason as `ActionPayload`
 * (src/actions.ts): this is the ONE place the result of a supplier search
 * becomes text the model reads, so an unexpected extra field is rejected at
 * the boundary rather than silently carried through. `sourceIds` are
 * supplier-origin and only ever reach the model through `renderResultsNote`,
 * which masks each one with `maskIdChars`.
 */
export const ResultsContentSchema = z.strictObject({
  kind: z.enum(['flights', 'hotels']),
  query: z.strictObject({
    from: z.string().min(1).max(64).optional(),
    to: z.string().min(1).max(64).optional(),
    place: z.string().min(1).max(128).optional(),
    // Exactly two letters: this is an ISO 3166-1 alpha-2 code from `places.json`, and it
    // becomes a `gl` query parameter. Nothing else is a country code.
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    outbound: z.string().regex(DATE_RE),
    inbound: z.string().regex(DATE_RE).nullable(),
    adults: z.number().int().min(1).max(20),
    cabin: CabinSchema.optional(),
  }),
  sourceIds: z.array(z.string().min(1).max(512)),
  assumptions: z.array(AssumptionSchema),
  filter: FilterSchema.optional(),
  refreshed: z.boolean().optional(),
  // The key is a supplier `sourceId`, same shape and cap as `sourceIds` above.
  verdicts: z.record(
    z.string().min(1).max(512),
    z.strictObject({
      matches: z.array(VerdictLabelSchema).max(8),
      issues: z.array(VerdictLabelSchema).max(8),
    }),
  ).optional(),
}) satisfies z.ZodType<ResultsContent>

/**
 * `questionId` matches the same shape as `ActionPayload`'s `choice` arm
 * (src/actions.ts) — ledger ruling 1: `IntakeOutcome.choices` carries
 * `questionId` ('origin' | 'destination' | 'outbound'), one of those short
 * lowercase names. `options[].id` matches `choice`'s `optionId` shape for
 * the same reason: it is exactly what comes back through that action once
 * she clicks. `question` and `label` are OUR OWN model's prose (the office
 * wrote them), not supplier- or traveller-authored, so they are plain bounded
 * strings rather than id-shaped — but `renderChoicesNote` below never embeds
 * a `label` into what the model reads, only `maskControlChars(question)` and
 * the option ids, so a label is never a channel for traveller-authored text
 * either way.
 *
 * `options` is `.min(2).max(4)` — spec section 3's range, matching `OfferChoices`
 * in src/tools/registry.ts, which has always enforced it on the driver's own
 * cards. It was `.min(1)` until the final review's C2: `buildAttachmentRows`
 * `.parse`s, so an intake card built from an empty option list threw inside the
 * park arm AFTER the Jev call was paid for, and failed her first turn. This is
 * now the backstop, not the contract: `placeOptions`/`dateOptions`
 * (src/intake/brief.ts) guarantee the range by construction, and the driver's
 * tool schema guarantees it for `offer_choices`. A violation here means a
 * builder regressed, and failing the parse is the right answer.
 */
export const ChoicesContentSchema = z.strictObject({
  questionId: z.string().regex(/^[a-z_]{1,32}$/),
  question: z.string().min(1).max(500),
  options: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
    label: z.string().min(1).max(200),
  })).min(2).max(4),
}) satisfies z.ZodType<ChoicesContent>

/**
 * Parses a `messages.content` string for a `results` row. Never throws: a
 * malformed row is `null`, and the caller hydrates that into
 * `UNREADABLE_ACTION_TEXT` rather than crashing the turn — the same contract
 * as `parseAction` (src/actions.ts).
 */
export function parseResults(content: string): ResultsContent | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = ResultsContentSchema.safeParse(json)
  return result.success ? result.data : null
}

/** Same contract as `parseResults`, for a `choices` row. */
export function parseChoices(content: string): ChoicesContent | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = ChoicesContentSchema.safeParse(json)
  return result.success ? result.data : null
}

/**
 * The text the model reads for a `results` row, via the same `system`-role
 * channel the operator actions use. Built entirely from this fixed template
 * plus the payload's own ids/enums/numbers; every `sourceId` is masked with
 * `maskIdChars` before it lands here, so a supplier-authored id can never put
 * a `"` or a newline into what the model reads.
 */
export function renderResultsNote(r: ResultsContent): string {
  const { kind, query, sourceIds } = r
  const n = sourceIds.length
  const from = query.from ?? query.place
  const to = query.to ?? ''
  const inboundPart = query.inbound ? ` returning ${query.inbound}` : ''
  const ids = sourceIds.map(maskIdChars).join(', ')
  return `Operator: the office showed her ${n} ${kind} for ${from} to ${to} on `
    + `${query.outbound}${inboundPart}; ids ${ids}. Discuss them; do not search again `
    + 'unless she changes the trip.'
}

/**
 * The text the model reads for a `choices` row. `question` is our own
 * model's prose, so it passes through `maskControlChars` (newline-injection
 * guard only, see src/sanitize.ts) rather than `maskUntrustedText`. Option
 * `label`s are never embedded — only their ids, which is all the model needs
 * to refer back to one of them.
 */
export function renderChoicesNote(c: ChoicesContent): string {
  const ids = c.options.map((o) => o.id).join(', ')
  return `Operator: the office asked her "${maskControlChars(c.question)}" with options `
    + `${ids}. Wait for her click.`
}
