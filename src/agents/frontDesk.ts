export type FrontLabel = 'new_trip' | 'faq' | 'unclear' | 'fallback'

/**
 * Plan 5 Task 6: the three FAQ topics `front_desk.md` used to ask Haiku to answer freely —
 * "what we do", "booking links not payment", "no cancellations/changes/visas" — as a FIXED
 * table instead. The router's `faq` intent (src/agents/router.ts) reads this, never the model:
 * Jev cannot generate text, only choose among options we hand it, and this is a small enough set
 * of topics that code can match the topic itself rather than asking Jev to.
 */
export type FaqTopic = 'what_we_do' | 'booking_links' | 'no_cancellations_visas'

export const FAQ_ANSWERS: Record<FaqTopic, string> = {
  what_we_do: 'We plan trips: we search real flights and hotels, show you the options, and put '
    + 'together an itinerary once you choose.',
  booking_links: 'We do not take payment ourselves. Once you accept a proposal we hand you '
    + 'booking links to the airline or hotel, and you pay them directly.',
  no_cancellations_visas: 'We do not handle cancellations, changes, refunds or visas — those go '
    + 'through the airline, the hotel, or your embassy directly.',
}

const FAQ_RULES: { topic: FaqTopic; test: (lower: string) => boolean }[] = [
  { topic: 'no_cancellations_visas', test: (t) => /\b(cancel\w*|refund\w*|visas?|change\s+my\s+(flight|booking|dates?))\b/.test(t) },
  { topic: 'booking_links', test: (t) => /\b(pay\w*|payment|card|charge\w*|booking\s+link\w*)\b/.test(t) },
  { topic: 'what_we_do', test: () => true },
]

/**
 * Code-side keyword match against her message, same instinct as `src/intake/filter.ts`'s
 * airline matching — no model call, ever. Falls through to the "what we do" answer when nothing
 * more specific matches, exactly as `front_desk.md`'s own fallback ordering ("new_trip when in
 * doubt") would: an unmatched FAQ-shaped message still gets a real answer, never a blank one.
 */
export function faqAnswer(text: string): string {
  const lower = text.toLowerCase()
  const rule = FAQ_RULES.find((r) => r.test(lower))!
  return FAQ_ANSWERS[rule.topic]
}

/**
 * Fix round 1: the Haiku front desk itself (`makeFrontDesk`, `parseFrontVerdict`,
 * `FrontDeskDeps`) is retired — `src/agents/router.ts`'s Jev classification runs on every
 * message now, first turn included (src/agents/intake.ts) or thereafter (this router), so
 * nothing in the live routing path builds this request any more.
 *
 * `FRONT_SCHEMA` stays exported anyway: `src/monitor/drift.ts` (a file owned by a different,
 * concurrently-running task — not touched here) still imports it to build its own `front_desk`
 * drift canary, as does `test/driver.live.test.ts`. Both also still load the `front_desk.md`
 * prompt themselves (`loadPrompt('front_desk')`/a direct file read) rather than through this
 * module, so deleting the schema or the prompt file out from under them would break code outside
 * this task's scope. The `front_desk` seat itself stays declared in src/model/seats.ts for the
 * same reason — `model_calls` history still references it — marked retired there.
 *
 * Hand-written, not zod: the API rejects zod's length keywords. Nullable fields are
 * `anyOf: [{type: 'string'}, {type: 'null'}]`, not `type: ['string', 'null']`
 * — the array-of-types shorthand is outside the documented structured-output
 * subset.
 */
export const FRONT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['new_trip', 'faq', 'unclear'] },
    answer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['label', 'answer', 'title'],
  additionalProperties: false,
}
