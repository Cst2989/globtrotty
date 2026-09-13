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
