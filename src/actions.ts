import { z } from 'zod'
import { SLOT_NAMES } from './gates/rehydrateGate.js'
import { maskControlChars, maskIdChars } from './sanitize.js'

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
 */
export const ActionPayload = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('hand_off'), proposalId: z.uuid() }),
  z.strictObject({
    action: z.literal('rejected'), proposalId: z.uuid(),
    reason: z.string().max(200).nullable(),
  }),
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
 * (a `system` message — see `src/engine.ts`). Carries only ids, enums, and
 * numbers straight from the schema above — a proposal id and a slot name are
 * OUR data, not supplier- or traveller-authored prose, so they are embedded
 * verbatim. The two exceptions are `reason` (free text she typed into the
 * card) and `sourceId` (supplier-origin, sanitized elsewhere but never for
 * newline injection specifically), which is why this is the one place that
 * calls `maskControlChars`/`maskIdChars` on them before they reach the model.
 *
 * Never contains a raw newline: `reason` is the only free-text field here,
 * and `maskControlChars` folds every line break in it to a single space, so a
 * multi-line "reason" can never read as a fresh block of instructions to the
 * model reading this message.
 */
export function renderActionMessage(a: ActionPayload): string {
  switch (a.action) {
    case 'hand_off':
      return `Operator: the traveller accepted proposal ${a.proposalId} using the card. `
        + 'Call hand_off_to_booking with that proposal id now. Do not ask her to confirm; '
        + 'the office already recorded her decision.'
    case 'rejected': {
      const said = a.reason !== null
        ? ` and said: "${maskControlChars(a.reason)}"`
        : ''
      return `Operator: the traveller rejected proposal ${a.proposalId} using the card${said}. `
        + 'Ask what she wants changed; do not re-propose the same items.'
    }
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
  }
}
