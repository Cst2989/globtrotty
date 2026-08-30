/** Above this a supplier-origin id is truncated, never rejected outright. */
const MAX_SOURCE_ID_LEN = 128

/**
 * Caps and MASKS a supplier-origin `sourceId` before it lands in text a
 * model reads — `propose_itinerary`'s accepted-items line and its per-gate
 * violation lines (`src/agents/driver.ts`), and `rehydrateRefs`'s
 * missing-reference violation (`src/gates/rehydrateGate.ts`). `sourceId` is
 * written by `recordResults` from whatever the supplier's response actually
 * contained — untrusted, unlike the surrounding text, which this repo
 * writes.
 *
 * "Masks", not "escapes": the substitution below is irreversible and does
 * not preserve meaning (`test/gate-rehydrate.test.ts` describes it correctly
 * — it neutralises a control character but does NOT HTML-escape `<`, `>` or
 * `/`, which are printable ASCII and pass through unchanged). Real escaping
 * in this repo (`escapeFence`, `escapeAttr`) is reversible and
 * meaning-preserving; this function is not that.
 *
 * Root-level and import-free by design: both call sites sit on opposite
 * sides of an import boundary (`gates/rehydrateGate.ts` is imported by
 * `tools/registry.ts`, which `tools/validate.ts` imports), so this cannot
 * live inside either `tools/` or `gates/` without creating a cycle through a
 * module-load `const` (`ProposalRefsSchema`), which throws at import time
 * (TDZ). A standalone module beside `src/money.ts` that imports nothing from
 * `src/` is reachable from both without that risk.
 */
export function sanitizeSourceId(id: string): string {
  // Printable ASCII only, and BEFORE capping — not after. A newline or control
  // character in a supplier id could otherwise inject what reads as a new
  // line of instructions into the tool result; '?' keeps the id recognisable
  // rather than dropping it. Masking first (rather than capping first, then
  // masking) matters: the '…' appended below is itself outside \x20-\x7e, so
  // masking AFTER capping would corrupt the marker this function just added.
  const masked = id.replace(/[^\x20-\x7e]/g, '?')
  return masked.length > MAX_SOURCE_ID_LEN ? `${masked.slice(0, MAX_SOURCE_ID_LEN)}…` : masked
}
