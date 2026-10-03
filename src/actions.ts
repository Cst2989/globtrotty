import { z } from 'zod'
import { SLOT_NAMES } from './gates/rehydrateGate.js'
import { maskIdChars } from './sanitize.js'

/**
 * A card action, written by a route handler (never the model) as a
 * `messages` row with `role = 'action'` and this JSON as `content`. `src/
 * worker.ts`'s `loop()` hydrates that row into a mid-conversation `system`
 * message via `renderActionMessage` below — see `src/engine.ts`'s
 * `LoopMessage` doc comment for why that role exists at all.
 *
 * `z.strictObject` on every arm: an action row is the ONE place a button
 * press becomes text the model reads, so an unexpected extra field (a client
 * bug, or something a traveller's browser was tricked into sending) is
 * rejected at the boundary rather than silently carried through.
 *
 * The operator channel carries ids and enums ONLY — no free text. `rejected`
 * deliberately has no `reason` field: a traveller's typed reason is HER
 * words, not a card action, and Task 8's decide route stores it as an
 * ordinary `role = 'user'` message instead, which the model reads through the
 * normal transcript rather than through this channel.
 */
export const ActionPayload = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('hand_off'), proposalId: z.uuid() }),
  z.strictObject({ action: z.literal('rejected'), proposalId: z.uuid() }),
  z.strictObject({
    action: z.literal('revise'), proposalId: z.uuid(),
    change: z.union([
      z.strictObject({
        kind: z.literal('swap'), slot: z.enum(SLOT_NAMES),
        sourceId: z.string().min(1).max(512),
      }),
      z.strictObject({ kind: z.literal('shift'), days: z.union([z.literal(-2), z.literal(2)]) }),
    ]),
  }),
  // Plan 5: the traveller picked a card out of a `results` row
  // (src/results.ts). `sourceId` is supplier-origin, same as `revise`'s swap
  // above, and gets the same `maskIdChars` treatment in `renderActionMessage`.
  z.strictObject({
    action: z.literal('choose'), kind: z.enum(['flight', 'hotel']),
    sourceId: z.string().min(1).max(512),
  }),
  // Plan 5: the traveller answered a `choices` row (src/results.ts) by
  // clicking one of its options. Both fields are ids/enums we generated
  // ourselves — `questionId` matches `ChoicesContent.questionId`'s shape,
  // `optionId` matches one of its `options[].id` — never free text, so a
  // traveller cannot smuggle her own words ("Tokyo please") through this
  // channel; the regex rejects anything that is not already id-shaped.
  z.strictObject({
    action: z.literal('choice'),
    questionId: z.string().regex(/^[a-z_]{1,32}$/),
    optionId: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
  }),
])
export type ActionPayload = z.infer<typeof ActionPayload>

/**
 * Parses a `messages.content` string for an `action` row. Never throws: a
 * malformed row (bad JSON, or JSON that fails the schema — a garbled write, a
 * future client bug) is `null`, and the caller (`src/worker.ts`) hydrates that
 * into a system message that says the action could not be read, rather than
 * crashing the turn.
 */
export function parseAction(content: string): ActionPayload | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = ActionPayload.safeParse(json)
  return result.success ? result.data : null
}

/**
 * The text the model reads for a card action, via the operator channel
 * (a `system` message — see `src/engine.ts`). Carries only ids and enums
 * straight from the schema above — a proposal id and a slot name are OUR
 * data, not supplier- or traveller-authored prose, so they are embedded
 * verbatim. The one exception is `sourceId` (supplier-origin), which is why
 * this is the one place that calls `maskIdChars` on it before it reaches the
 * model.
 *
 * Every returned string is built ENTIRELY from this fixed set of template
 * fragments plus the payload's own ids/enums/numbers — never a traveller's
 * free text (there is none left in `ActionPayload` to embed) — so it can
 * never contain a `"` character or a raw newline.
 */
export function renderActionMessage(a: ActionPayload): string {
  switch (a.action) {
    case 'hand_off':
      return `Operator: the traveller accepted proposal ${a.proposalId} using the card. `
        + 'Call hand_off_to_booking with that proposal id now. Do not ask her to confirm; '
        + 'the office already recorded her decision.'
    case 'rejected':
      return `Operator: the traveller rejected proposal ${a.proposalId} using the card. `
        + 'Her reason, if she gave one, is in her own message. Ask what she wants changed; '
        + 'do not re-propose the same items.'
    case 'revise':
      if (a.change.kind === 'swap') {
        return 'Operator: the traveller asked, via the card, to swap the '
          + `${a.change.slot} in proposal ${a.proposalId} for search result `
          + `${maskIdChars(a.change.sourceId)}. Call revise_component with exactly that change.`
      }
      return `Operator: the traveller asked, via the card, to shift proposal ${a.proposalId} `
        + `by ${a.change.days} days. Call revise_component with { kind: 'shift', days: `
        + `${a.change.days} }; if the corpus lacks those dates it will tell you to search `
        + 'them first — do so, then revise.'
    case 'choose':
      return `Operator: the traveller chose ${a.kind} ${maskIdChars(a.sourceId)} from the list. `
        + 'The office has recorded it and is searching the next step; do not ask her to confirm.'
    case 'choice':
      return `Operator: to the question ${a.questionId} she chose ${a.optionId}.`
  }
}

/** The text the UI shows the traveller for her own action. Ids stay server-side. */
export function describeActionForUi(a: ActionPayload): string {
  switch (a.action) {
    case 'hand_off':
      return 'You accepted the proposal'
    case 'rejected':
      return 'You rejected the proposal'
    case 'revise':
      return 'You asked to revise the proposal'
    case 'choose':
      return a.kind === 'flight' ? 'You chose a flight' : 'You chose a hotel'
    case 'choice':
      return 'You answered a question'
  }
}
