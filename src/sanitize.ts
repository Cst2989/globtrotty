import { BOOKING_HOSTS } from './cashier.js'

/**
 * A source id is a supplier's string. It reaches the model in a search result
 * and it comes back in a proposal, and anything a supplier can put in a string
 * it can put there.
 *
 * NOT the same call sites main has. Main's version of this comment names
 * `propose_itinerary`'s acceptance line and its rejection line, and on this
 * branch neither of those interpolates an id into prose: `proposalRunner`
 * (src/gates/runner.ts) builds both answers with `JSON.stringify`, so a newline
 * or a delimiter inside an id is escaped by the serialiser. The one place on
 * this branch where an id is quoted back into a sentence WE wrote, unserialised,
 * is `rehydrateRefs`'s `provenance` violation (src/gates/rehydrateGate.ts), and
 * it is also the only place where the id came from the model rather than out of
 * `course.tool_results`.
 */
export const MAX_SOURCE_ID_LEN = 128

/**
 * Printable ASCII only, then capped.
 *
 * The order matters and it is the opposite of the obvious one. Stripping after
 * capping would cap a string that still contained a newline and then remove the
 * newline, leaving a length nobody promised; stripping first means the cap
 * applies to the string that is actually emitted.
 *
 * `[^\x20-\x7e]` removes newlines, control characters, and every non-ASCII
 * character including the homoglyphs that make a delimiter look closed to a
 * human. A real source id from any supplier this branch ships is hex, digits and
 * hyphens, so nothing legitimate is lost.
 */
export function sanitizeSourceId(id: string): string {
  return id.replace(/[^\x20-\x7e]/g, '').slice(0, MAX_SOURCE_ID_LEN)
}

/**
 * Phrases the agency never uses, in either direction.
 *
 * A blocklist, and it is the right shape here for one reason: the agency has no
 * legitimate use for any of them. It never takes a payment, never holds a
 * document and never verifies an identity, so there is no true positive to
 * balance against. That is not true of the image check below, which is why that
 * one is an allowlist.
 */
export const SOLICITATION_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'card', pattern: /\b(card\s*(number|details)|cvv|cvc|expiry\s*date|credit\s*card)\b/i },
  { name: 'document', pattern: /\b(passport|id\s*card|driving\s*licence|driver'?s\s*license)\s*(scan|photo|copy|number)\b/i },
  { name: 'payment', pattern: /\b(wire|transfer|iban|swift|paypal|deposit)\b.{0,40}\b(to secure|to hold|to confirm)\b/i },
  { name: 'credential', pattern: /\b(password|one[- ]time code|verification code|2fa)\b/i },
]

/**
 * The hosts the cashier builds links against. Nothing else may appear as a URL.
 *
 * DERIVED from `BOOKING_HOSTS` (src/cashier.ts) and never written out again
 * here. The agency emits exactly one kind of link, built server side by the
 * cashier from a fixed template against a known host, and that map is where the
 * host per supplier is decided; a second list beside it would be a second
 * definition of a money-adjacent rule, which is the duplication `trimForContext`
 * refuses one file over. It also diverges in exactly the way this project cannot
 * see: a hand-written list would have carried `www.booking.com`, which this
 * branch never builds a link for, and would have missed `example.invalid`,
 * which is the host every mock hand-off emits, so `npm run demo` and every
 * mock-supplier test would have had their booking links stripped by the check
 * that exists to protect them.
 *
 * A supplier added to `BOOKING_HOSTS` is therefore trusted here the moment it is
 * trusted there, which is the right coupling: the thing that decides where a
 * link may point is the thing that builds links.
 */
const ALLOWED_HOSTS = new Set(Object.values(BOOKING_HOSTS))

export type OutboundVerdict = { ok: true; text: string } | { ok: false; text: string; reasons: string[] }

/**
 * The last thing between the model and her screen, applied to every agent
 * message before `completeTurn` writes it and to every `ask_user` question.
 *
 * ## Why an image is the case that matters
 *
 * Every defence this course has built so far watches a TOOL CALL. A markdown
 * image is not a tool call: the model writes six characters of syntax, her
 * browser fetches the URL, and whatever is in the query string is now on
 * somebody else's server. The allowlist and the fences never see it, because
 * nothing was called.
 *
 * So the URL check is an ALLOWLIST rather than a blocklist. The agency emits
 * exactly one kind of link, built server side by the cashier against a fixed
 * template and a known host (lesson 4.6), so anything else is wrong by
 * construction and there is no legitimate case to weigh. A blocklist of known
 * bad hosts would be a list somebody has to maintain against an attacker who
 * registers domains for a living.
 *
 * ## What this does not do
 *
 * It does not stop the model saying something wrong, and it is not a content
 * filter. It removes two categories with no legitimate instance: a URL to a host
 * we do not build links for, and a request for money or documents. Everything
 * else passes unchanged, which is what keeps it from being turned off.
 *
 * The browser's half of SPEC section 10 is not here and cannot be: a Content
 * Security Policy with `img-src 'self'` would stop the image at the renderer
 * even if this check missed it, and the persistent "we never ask for payment"
 * line under the composer is what makes the solicitation rule legible to her
 * rather than only to us. This repository has no browser. Both are named in
 * README.md as owed.
 */
export function sanitizeOutbound(text: string): OutboundVerdict {
  const reasons: string[] = []
  let out = text

  out = out.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (whole, url: string) => {
    if (isAllowed(url)) return whole
    reasons.push('remote_image')
    return '[image removed]'
  })
  out = out.replace(/https?:\/\/[^\s)\]]+/g, (url) => {
    if (isAllowed(url)) return url
    reasons.push('remote_link')
    return '[link removed]'
  })

  for (const p of SOLICITATION_PATTERNS) {
    if (!p.pattern.test(out)) continue
    reasons.push('solicitation')
    // Replaced wholesale rather than redacted word by word, because a sentence
    // with the card number removed still asks her for a card number.
    return {
      ok: false,
      text: 'I cannot help with that here. Globetrotty never asks for a payment, a card number '
        + 'or a document in a message, so please do not send one. Tell me about the trip and I '
        + 'will keep planning.',
      reasons,
    }
  }
  return reasons.length === 0 ? { ok: true, text: out } : { ok: false, text: out, reasons }
}

function isAllowed(raw: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(raw).host)
  } catch {
    // Not a URL we can parse is not a URL we allow. A parser that threw and a
    // caller that then let the string through would be the hole.
    return false
  }
}
