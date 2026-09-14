/** Above this a piece of supplier-origin text is truncated, never rejected outright. */
const MAX_UNTRUSTED_TEXT_LEN = 128

/**
 * Caps and MASKS a piece of supplier-origin text before it lands anywhere a
 * model reads it. The one definition both `sanitizeSourceId` (below) and
 * `src/agents/reviewer.ts`'s `renderOfferForReview` call for every
 * supplier-written string it renders (name, flight numbers, airports,
 * departure times, hotel dates) — a supplier response is untrusted, unlike
 * the surrounding text, which this repo writes.
 *
 * "Masks", not "escapes": the substitution below is irreversible and does
 * not preserve meaning (`test/gate-rehydrate.test.ts` describes it correctly
 * — it neutralises a control character but does NOT HTML-escape `<`, `>` or
 * `/`, which are printable ASCII and pass through unchanged). Real escaping
 * in this repo (`escapeFence`, `escapeAttr` in `src/tools/validate.ts`) is
 * reversible and meaning-preserving; this function is not that.
 *
 * Root-level and import-free by design: `sanitizeSourceId`'s call sites sit on
 * opposite sides of an import boundary (`gates/rehydrateGate.ts` is imported
 * by `tools/registry.ts`, which `tools/validate.ts` imports), so this cannot
 * live inside either `tools/` or `gates/` without creating a cycle through a
 * module-load `const` (`ProposalRefsSchema`), which throws at import time
 * (TDZ). A standalone module beside `src/money.ts` that imports nothing from
 * `src/` is reachable from both, and from `src/agents/reviewer.ts`, without
 * that risk.
 */
export function maskUntrustedText(s: string): string {
  // Printable ASCII only, and BEFORE capping — not after. A newline or control
  // character in supplier text could otherwise inject what reads as a new
  // line of instructions into the tool result; '?' keeps the text recognisable
  // rather than dropping it. Masking first (rather than capping first, then
  // masking) matters: the '…' appended below is itself outside \x20-\x7e, so
  // masking AFTER capping would corrupt the marker this function just added.
  const masked = s.replace(/[^\x20-\x7e]/g, '?')
  return masked.length > MAX_UNTRUSTED_TEXT_LEN
    ? `${masked.slice(0, MAX_UNTRUSTED_TEXT_LEN)}…`
    : masked
}

/**
 * `sourceId` is written by `recordResults` from whatever the supplier's
 * response actually contained — see `maskUntrustedText` above for what this
 * does and why. Kept as a named wrapper (rather than every call site calling
 * `maskUntrustedText` directly) because "this is a sourceId" is itself
 * documentation at each of its call sites: `propose_itinerary`'s
 * accepted-items line and its per-gate violation lines
 * (`src/agents/driver.ts`), and `rehydrateRefs`'s missing-reference violation
 * (`src/gates/rehydrateGate.ts`).
 */
export function sanitizeSourceId(id: string): string {
  return maskUntrustedText(id)
}

/**
 * For a supplier-origin id rendered where it reads as an ID rather than as
 * prose — `src/agents/driver.ts`'s `renderExpiredNotice`, a comma-joined list
 * of ids in a Markdown heading's body. `maskUntrustedText`'s `'?'` is the
 * right mask for prose (it stays visually a sentence); here it would leave a
 * `?` sitting inside what reads as an identifier, which is a worse fit than a
 * hyphen — the character an id-shaped string would plausibly already use
 * as a separator. Anything that is not a letter, digit, or one of `._:-`
 * becomes `'-'`, and the same 128-character cap (with the same `…` marker)
 * as `sanitizeSourceId` applies, for the same reason: this is still
 * supplier-origin, still untrusted, and still capped before it reaches a
 * model's context.
 */
export function maskIdChars(id: string): string {
  const masked = id.replace(/[^A-Za-z0-9._:-]/g, '-')
  return masked.length > MAX_UNTRUSTED_TEXT_LEN
    ? `${masked.slice(0, MAX_UNTRUSTED_TEXT_LEN)}…`
    : masked
}

/**
 * For OUR OWN model's prose (a front-desk answer, a title, a reviewer's issue,
 * a scout brief): strips only control characters and line separators, keeps
 * Unicode letters, no length cap. Supplier strings and ids keep
 * `maskUntrustedText` — this is not a replacement for it. A supplier response
 * still needs the newline-injection guard (a `\n` that could read as a new
 * line of instructions) AND the printable-ASCII cap, because it is genuinely
 * untrusted; our own model's output needs only the newline-injection guard —
 * "Málaga" is not an attack and must not become "M?laga".
 *
 * `\u2028`/`\u2029` (LINE/PARAGRAPH SEPARATOR) are included alongside the
 * ASCII control ranges: both are valid "letters" as far as `\p{L}` is
 * concerned but read as a line break to a model the same way `\n` does, so
 * the newline-injection guard has to cover them too.
 *
 * Line breaks (`\n`, `\r`, `\t`, `\u2028`, `\u2029`) map to a single space,
 * not `'?'`: our own model's prose can legitimately contain them (a
 * paragraph break in an answer, a tab in pasted text), and a run of visible
 * `?` characters where a line break belongs reads as corruption rather than
 * the harmless reflow it actually is. The newline-INJECTION guard this
 * function exists for is about the STRUCTURE a line break creates in the
 * model's context (a fake "new line of instructions"), not about the
 * character being displayed \u2014 collapsing it to a space defeats the
 * injection just as completely as `'?'` did. Every OTHER C0/C1 control
 * character (a stray `\x07` BEL, for instance) has no legitimate reason to
 * appear in our own model's prose at all, so those still become `'?'` \u2014
 * visibly wrong, which is the point for a character that is never expected.
 */
export function maskControlChars(s: string): string {
  return s
    .replace(/[\n\r\t\u2028\u2029]/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '?')
}

export const PRICE_REDACTED = '[price removed]'

// A number with optional thousands separators and decimals, in either the
// 1,200.50 or the 1.200,50 convention, and an optional bare "k" (thousands)
// suffix directly against the digits ("1.2k", never "1.2 k").
const NUM_CORE = String.raw`\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
const NUM = String.raw`(?:${NUM_CORE})[kK]?`
// A range between two NUMs, hyphen/en-dash or "to" between them, spaces
// optional on either side: "200-400", "80\u2013120", "80 to 120".
const RANGE = String.raw`(?:${NUM})(?:\s?[-\u2013]\s?|\s?to\s?)(?:${NUM})`
// A priceable value is either a single number or a range of them \u2014 every
// symbol/ISO/postfix/spelled-currency pattern below accepts either shape.
const VAL = String.raw`(?:${RANGE}|${NUM})`
const SYM = String.raw`[\u20ac$\u00a3\u00a5]`
const ISO = String.raw`(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK|HUF|RON)`
// M9: 'day', 'week' and 'each' dropped — each is common in a plain count
// ("4 per day", "runs 9 to 5 each day") that has nothing to do with money,
// and a bare number immediately before one of those words is too weak a
// signal on its own to redact. 'night', 'person', 'adult', 'room', 'pp' and
// 'p.p.' remain: none of those has an ordinary non-price reading.
const UNIT = String.raw`(?:per\s+(?:night|person|adult|room)|pp|p\.p\.|a\s+night)`
// Spelled-out currency words a scout might plausibly write instead of a
// symbol or an ISO code. Case-insensitive (see the 'gi' flag below) \u2014 unlike
// the ISO codes, which are only ever written uppercase.
const CURRENCY_WORD = String.raw`(?:euros?|dollars?|pounds?|francs?|yen|kronor?|zloty)`

const PRICE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${SYM}\s?(?:${VAL})`, 'g'), // \u20ac89, $1,200, $200-400, \u20ac80\u2013120, \u20ac1.2k
  new RegExp(String.raw`\b${ISO}\s?(?:${VAL})\b`, 'g'), // EUR 45, USD1200, USD 1.2k
  new RegExp(String.raw`\b(?:${VAL})\s?${ISO}\b`, 'g'), // 45 EUR
  new RegExp(String.raw`\b(?:${VAL})(?=\s?${UNIT}\b)`, 'g'), // 120 per night, 30 pp
  new RegExp(String.raw`\b(?:${VAL})\s?${SYM}`, 'g'), // 89\u20ac, 89 \u20ac
  new RegExp(String.raw`\b(?:${VAL})\s?${CURRENCY_WORD}\b`, 'gi'), // 89 euros, 50 dollars, 12 pounds
]

/**
 * Parent spec section 9: "a deterministic post-filter redacts currency-shaped
 * tokens". Used on scout briefs now (section 4: "words never prices") and on
 * the streamed prose channel in plan 4. Deliberately over-eager: a redacted
 * "population 500,000 EUR" is a harmless oddity; a surviving "from \u20ac89" is the
 * one failure this product must not have. Bare numbers without a currency or a
 * per-unit word are left alone \u2014 durations, bus numbers, centuries.
 */
export function redactPrices(text: string): string {
  let out = text
  for (const re of PRICE_PATTERNS) out = out.replace(re, PRICE_REDACTED)
  return out
}

/** Cuts to at most `maxWords`, preferring the last sentence boundary under the cap. */
export function cutAtWords(text: string, maxWords: number): { text: string; cut: boolean } {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length <= maxWords) return { text, cut: false }
  const head = words.slice(0, maxWords).join(' ')
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.endsWith('.') ? head.length - 1 : -1)
  return { text: lastStop > 0 ? head.slice(0, lastStop + 1) : head, cut: true }
}
