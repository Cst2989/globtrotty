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
 */
export function maskControlChars(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?')
}

export const PRICE_REDACTED = '[price removed]'

// A number with optional thousands separators and decimals, in either the
// 1,200.50 or the 1.200,50 convention.
const NUM = String.raw`\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
const SYM = String.raw`[\u20ac$\u00a3\u00a5]`
const ISO = String.raw`(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK|HUF|RON)`
const UNIT = String.raw`(?:per\s+(?:night|person|adult|day|week|room)|pp|p\.p\.|a\s+night|each)`

const PRICE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${SYM}\s?(?:${NUM})`, 'g'), // \u20ac89, $1,200
  new RegExp(String.raw`\b${ISO}\s?(?:${NUM})\b`, 'g'), // EUR 45, USD1200
  new RegExp(String.raw`\b(?:${NUM})\s?${ISO}\b`, 'g'), // 45 EUR
  new RegExp(String.raw`\b(?:${NUM})(?=\s?${UNIT}\b)`, 'g'), // 120 per night, 30 pp
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
