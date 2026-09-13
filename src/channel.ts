import type postgres from 'postgres'
import { handOffToBooking, type HandOff } from './cashier.js'
import type { Limits } from './engine.js'
import { TURN_FAILED_MESSAGE } from './failure-message.js'
import { checkTotals } from './gates/checks.js'
import { rehydrateRefs } from './gates/rehydrateGate.js'
import type { GateOutcome } from './gates/types.js'
import { formatMoney } from './money.js'
import { emittedForProposal, type EmittedLink } from './repo/linkClicks.js'
import { decideProposal, loadProposal } from './repo/proposals.js'
import { sanitizeSourceId } from './sanitize.js'
import type { SupplierPair } from './supplier/types.js'

/**
 * Every currency-shaped token out of a chunk of the model's prose.
 *
 * Applied to a streamed delta rather than to a finished message, and that is
 * why it is a pure function over a string with no state: a delta can split a
 * number across a chunk boundary, so a stateful redactor that had seen "41"
 * and was waiting for the rest would have to buffer, and a buffer in front of a
 * stream is a stream that stutters. This one over-redacts at a boundary instead,
 * turning a split amount into two redactions, which is visible and harmless.
 * SPEC section 9 puts the guarantee in the renderer rather than in the model's
 * self-restraint, and this is the renderer's half.
 *
 * Nothing on this branch streams. `callModel` sends a non-streaming request
 * (src/model/client.ts) and tier 3 writes one `course.messages` row at the end
 * of a turn, so `src/worker.ts` runs this over a whole message. It is written
 * for the chunk anyway, and the chunk boundary is tested, because that is the
 * property a redactor cannot be given later: swapping a buffering one out once
 * prose is arriving live is a change nobody makes calmly.
 *
 * It does not try to tell a real price from a made-up one, because it cannot and
 * because that is not the split. Every amount goes, including one the model
 * quoted correctly out of a search result, and she is shown the amount in the
 * card underneath, which the server built from what the gates rehydrated.
 *
 * A year is not a currency, and neither is a flight number or a time. The
 * pattern requires a currency marker, a symbol or an ISO code adjacent to the
 * digits, so "2026" and "TP1234" and "07:45" survive and "412 EUR", "EUR412",
 * "€412", "412 euros" and "412.00" next to a symbol do not.
 */
export function redactCurrency(delta: string): string {
  let out = delta
  for (const p of CURRENCY_PATTERNS) out = out.replace(p, '[amount]')
  return out
}

/**
 * A digit run with a currency marker adjacent to it, in the four arrangements
 * that occur: symbol first, symbol last, code or word first, code or word last.
 *
 * The MARKER is what makes it a price, and that is the whole of the design. A
 * pattern over bare digits would eat "2026", "TP1234" and "07:45", and a
 * redactor that ate the departure date is one somebody turns off, which leaves
 * the amounts in too.
 *
 * The number is `\d[\d.,]*` rather than a strict decimal, so "1,742", "412.00"
 * and the continental "412,50" all match, and a trailing comma or full stop
 * swallowed from ordinary prose costs nothing because it is only swallowed when
 * a currency marker follows it.
 */
const CURRENCY_SYMBOL = '[$€£¥]'
const CURRENCY_WORD =
  '(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|JPY|euros?|dollars?|pounds?)'
const AMOUNT = '\\d[\\d.,]*'
const CURRENCY_PATTERNS: RegExp[] = [
  new RegExp(`${CURRENCY_SYMBOL}\\s?${AMOUNT}`, 'gi'),
  new RegExp(`${AMOUNT}\\s?${CURRENCY_SYMBOL}`, 'gi'),
  new RegExp(`\\b${CURRENCY_WORD}\\s?${AMOUNT}`, 'gi'),
  new RegExp(`\\b${AMOUNT}\\s?${CURRENCY_WORD}\\b`, 'gi'),
]

/** One line of the card, with the change action that belongs to that line. */
export type CardComponent = {
  slot: string
  sourceId: string
  name: string
  price: string
  revisable: boolean
}

export type ProposalCard = {
  proposalId: string
  total: string
  components: CardComponent[]
  links: { sourceId: string; url: string }[]
  footer: string
}

/**
 * On every card, and a constant rather than a prompt line. A prompt is an
 * instruction to a model and this is a promise to her, and the two fail
 * differently: a model that ignores its prompt still ships a card carrying this.
 */
export const CARD_FOOTER =
  'Globetrotty never asks for a payment, a card number or a document in a message.'

/**
 * The proposal, as the thing she is actually shown.
 *
 * Built from a `GateOutcome` and from the `EmittedLink` rows the cashier already
 * wrote, and from nothing the model said. Every price on it was rehydrated from
 * `course.tool_results` by the rehydration gate (lesson 4.4), summed by
 * `checkTotals` (lesson 4.5), and formatted by `formatMoney`, so the number on
 * the card is a number the server read out of its own record of a search. That
 * is the same guarantee the prose channel cannot make, which is why the prose
 * has its amounts taken out and the card has them.
 *
 * A pure function returning a structure, not HTML, and that is deliberate rather
 * than a shortcut. This repository has no renderer: `public/index.html` is a
 * placeholder and `npm run trip` prints to a terminal. Returning a structure
 * means the card can be printed as text today and rendered as a component the
 * day there is a browser, with the same function deciding what is on it, and it
 * means the test is an assertion about content rather than about markup.
 *
 * `revisable` is per component, because "change the hotel" is a thing she can
 * say about one line of a trip and `revise_component` is the tool that carries
 * it. A card with one accept button and no per-line action makes her restate the
 * whole trip to change one night.
 *
 * The footer is a constant and it is on every card: the agency never asks for a
 * payment, a card number or a document in a message. It is here rather than only
 * in the desk prompt because a prompt is an instruction to the model and this is
 * a promise to her, and the two fail differently.
 */
export function renderProposalCard(
  outcome: GateOutcome, links: EmittedLink[], proposalId: string,
): ProposalCard {
  if (!outcome.ok) {
    throw new Error(`renderProposalCard: refusing to render a rejected proposal ${proposalId}`)
  }
  return {
    proposalId,
    total: formatMoney(outcome.total),
    components: outcome.items.map((i) => ({
      slot: i.ref.slot,
      // Both a supplier's string, so both cleaned, and cleaned HERE rather than
      // at the caller: this function is the only thing that builds a card, so
      // this is the only place it can be forgotten. Two different cleanings,
      // because they are two different kinds of string, and the reason is on
      // `displayName` below.
      sourceId: sanitizeSourceId(i.ref.sourceId),
      name: displayName(i.item.name),
      // formatMoney over the line total the rehydration gate computed, never
      // over anything on the ref, which carries no price field at all.
      price: formatMoney(i.lineTotal),
      revisable: true,
    })),
    links: links.map((l) => ({ sourceId: sanitizeSourceId(l.sourceId), url: l.url })),
    footer: CARD_FOOTER,
  }
}

/** The longest supplier name a card line carries. Beyond this it is truncated. */
export const MAX_CARD_NAME_LEN = 120

/**
 * A supplier's own words for what it is selling, made safe to put on a line she
 * reads, and NOT through `sanitizeSourceId`.
 *
 * That function is an allowlist of `[A-Za-z0-9_-]` since lesson 5.5's fix round,
 * which is exactly right for an id and destroys a name: "Beachfront apartment,
 * Faro, 7 nights" comes out of it as one unreadable word, and a card whose lines
 * she cannot read is a card she cannot check. So the name keeps its spaces and
 * its punctuation and loses the two things that are not text at all: control
 * characters, which is what would let a supplier's string fake a second line or
 * a heading on the card, and any length past the cap, because a name is a label
 * and a supplier can send a paragraph.
 *
 * It does not escape markup, deliberately. This function returns a structure and
 * not HTML (see `renderProposalCard`), so escaping belongs to whatever renders
 * it; doing it here would double-escape the day a renderer exists and would say
 * nothing at all about the terminal that prints it today.
 */
function displayName(name: string): string {
  let out = ''
  for (const ch of name) {
    const code = ch.codePointAt(0)!
    // C0 and C1, replaced by a space rather than dropped, so a name carrying
    // a newline reads as two words on one line and not as one word nobody
    // wrote. Compared by code point rather than matched by a regular
    // expression, so this file holds no control character of its own.
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch
  }
  return out.slice(0, MAX_CARD_NAME_LEN).trim()
}

/**
 * The card for a proposal that is already recorded, rebuilt from the corpus.
 *
 * Two terminals print a card, `npm run trip` and `npm run demo`'s sixth
 * scenario, and this is here so they print the same one. It re-reads rather than
 * re-judges: `rehydrateRefs` and `checkTotals` write nothing, so building a card
 * does not file a second round of `course.gate_results` rows describing a gate
 * run that was really a render. The proposal it is given passed the gates when
 * it was recorded, which is the only reason a row exists at all
 * (`proposalRunner`, src/gates/runner.ts, writes one only on a pass).
 *
 * Returns null for a proposal that is not this conversation's, through
 * `loadProposal`'s own (id, conversation_id) read, and throws through
 * `renderProposalCard` if what the corpus now holds no longer rehydrates: a
 * card is the thing she accepts, and one built from an incomplete rehydration
 * would put an unverified total in front of her.
 */
export async function cardForProposal(
  sql: postgres.Sql,
  args: { proposalId: string; conversationId: string; currency: string | null },
): Promise<ProposalCard | null> {
  const proposal = await loadProposal(sql, args.proposalId, args.conversationId)
  if (!proposal) return null
  // Both refusals below hand `renderProposalCard` a rejected outcome, which is
  // its documented throw. Written that way rather than as two throws of their
  // own so there is ONE sentence in this codebase for "this is not something
  // she can be shown", and so a caller catches one thing.
  const hydrated = await rehydrateRefs(sql, args.conversationId, proposal.refs)
  if (!hydrated.ok) return renderProposalCard(hydrated, [], args.proposalId)
  const { violations, total } = checkTotals(hydrated.items, args.currency)
  if (total === null) {
    return renderProposalCard({ ok: false, violations }, [], args.proposalId)
  }
  return renderProposalCard(
    { ok: true, items: hydrated.items, total },
    await emittedForProposal(sql, args.proposalId),
    args.proposalId,
  )
}

/**
 * Every status `conversations_status_check` accepts, as ONE runtime constant.
 *
 * The same arrangement `GATE_NAMES` has and for the same reason: `statusInWords`
 * switches over this list and `test/schema.test.ts` reads the constraint out of
 * `pg_constraint` and compares it against this, so a status added to the column
 * with no sentence behind it is a red test rather than a caption she reads as
 * "Ready when you are" while a person is in fact waiting to pick her request up.
 */
export const CONVERSATION_STATUSES = [
  'active', 'working', 'awaiting_user', 'limit_reached', 'escalated', 'failed', 'archived',
] as const

/**
 * What a stopped turn looks like to her, from the two columns that record it.
 *
 * Seven statuses and twelve fail reasons is a lot of vocabulary and she needs
 * none of it. What she needs is which of a few things is true: it is still
 * going, it is waiting on her, a person is picking it up, or it stopped. This
 * maps a row onto one of those and says what happens next, because a status with
 * no next step is a spinner with a caption.
 *
 * `limit_reached` is deliberately not folded into the failure line, and it
 * arrives twice: as a conversation status `failTurn` writes and as the fail
 * reason on the turn underneath it. A capped request is not a broken one, and
 * telling her the system broke when she was in fact capped is the specific wrong
 * thing `failTurn`'s conversation guard was written to avoid (src/repo/turns.ts,
 * lesson 3.5).
 *
 * It DEFERS rather than restating, and that is the one interesting decision
 * here. `LIMIT_REACHED_MESSAGE` has three sentences, one per ceiling, and
 * `limitReachedMessage` picks between them from a `Spend` and a `Limits` that
 * this function is not given and should not be: a status caption that took the
 * whole ceiling machinery as arguments would be a second place the ceiling is
 * interpreted. The specific sentence is already in `course.messages`, written by
 * `src/loop.ts` at the moment the ceiling fired, so the caption points at it and
 * says the one thing the message does not, which is that nothing else is coming.
 *
 * Every other fail reason gets `TURN_FAILED_MESSAGE`, which is one sentence in
 * one place for the reason that file gives: a failure must look the same to her
 * wherever it was noticed.
 */
export function statusInWords(status: string, failReason: string | null): string {
  switch (status) {
    case 'working':
      return 'Working on it now. This can take a minute or two.'
    case 'awaiting_user':
      return 'Waiting on you. Answer above and I will carry on.'
    case 'escalated':
      // No fail reason is read here, and there is none to read: an escalated
      // conversation's last turn ended `done`. The distinction between a
      // conversation status and a turn fail reason, in one line of code.
      return 'A person from the agency is picking this up. Nothing more is needed from you now.'
    case 'limit_reached':
      return LIMIT_STOPPED
    case 'failed':
      return failReason === 'limit_reached' ? LIMIT_STOPPED : TURN_FAILED_MESSAGE
    case 'archived':
      return 'This conversation is closed. Start a new one and I will pick it up from there.'
    default:
      return 'Ready when you are.'
  }
}

/**
 * The one sentence both halves of a capped request get: the conversation status
 * `failTurn` writes and the fail reason on the turn underneath it are the same
 * fact recorded in two columns, and telling her two different things about one
 * fact is how a caption stops being believed.
 */
const LIMIT_STOPPED =
  'Stopped by a spending limit. The message above says which one, and nothing further ran.'

/**
 * What the accept button does on the server. One function, so the terminal in
 * `npm run trip`, the demo's sixth scenario and whatever browser eventually
 * exists all take the same path, and `decideProposal` keeps exactly one caller.
 *
 * The order is: decide, then hand off. Not the reverse and not one call, because
 * `decideProposal` refuses a second answer (`decision is null` in its WHERE) and
 * `handOffToBooking` refuses a proposal whose acceptance is older than thirty
 * minutes. Deciding first means a hand-off that fails on a supplier still leaves
 * a recorded acceptance she can see, rather than a click that did nothing.
 */
export async function acceptCard(
  sql: postgres.Sql,
  args: { proposalId: string; conversationId: string; userId: string
          turnId: string | null; suppliers: SupplierPair; limits: Limits; now: Date },
): Promise<HandOff> {
  await decideProposal(sql, {
    proposalId: args.proposalId, conversationId: args.conversationId,
    decision: 'accept', at: args.now,
  })
  return handOffToBooking(sql, { ...args })
}
