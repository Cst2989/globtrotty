import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Carrier code -> airline name, from `airlines.json` (built by
 * `scripts/build-airlines.mjs` out of OpenFlights' airlines.dat; see that script for what it
 * keeps and why a handful of codes are hand-resolved).
 *
 * A `LegSummary.carriers` entry (src/supplier/types.ts) is a two-letter IATA code a SUPPLIER put
 * in the corpus — "QR", "MU" — and a flight card has to show a human a name and a logo, not a
 * code. This is the only table that answers that; `places.json` cannot, since it is keyed on
 * metro codes and knows nothing about airlines.
 *
 * Ships as a FILE read at import time, not a bundled `import` of the JSON: a reviewable diff
 * shows exactly which carrier changed, the same reasoning `src/intake/places.ts` records for
 * places.json. Node-only, therefore — `web/data.ts` (a server module) resolves the names into
 * `ResultItemLite.flight.airlineNames` before anything reaches the browser.
 */
function loadAirlines(from: string = import.meta.url): Record<string, string> {
  const beside = fileURLToPath(new URL('./airlines.json', from))
  const raw = existsSync(beside)
    ? readFileSync(beside, 'utf8')
    : readFileSync(path.join(process.cwd(), 'src', 'intake', 'airlines.json'), 'utf8')
  return JSON.parse(raw) as Record<string, string>
}

export const AIRLINES: Record<string, string> = loadAirlines()

/**
 * The airline's name for a carrier code, or `null` when the table does not know it — never the
 * code itself, so the caller decides what to show instead (the card falls back to the code in a
 * styled circle). Case-insensitive on the way in, because nothing guarantees a supplier
 * upper-cases what it sends.
 */
export function airlineName(code: string): string | null {
  return AIRLINES[code.trim().toUpperCase()] ?? null
}
