import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * ISO 3166-1 alpha-2 -> the country's English name, for the one job this table has: a hotel
 * search's `q` reads `hotels in Tokyo, Japan`, and `places.json` carries only `JP`.
 *
 * Deliberately small — one entry per country `places.json` actually names (130 of them), not
 * the full ISO list — and deliberately a committed file rather than `Intl.DisplayNames`, which
 * is what GENERATED it: ICU's names drift between Node releases ("Turkey" became "Türkiye",
 * "Czechia" replaced "Czech Republic") and a supplier query string is not somewhere a silent
 * runtime-dependent change belongs. Every name is plain ASCII, matching `places.json`'s own
 * city names ("Malaga", "Dusseldorf"), so a query never carries a character a URL has to argue
 * about.
 *
 * Regenerate (then eyeball the diff) with:
 *   node -e "..." — see the generation note in docs/work-log.md for the hotels pass.
 *
 * Same file-read-at-import posture as `places.ts`/`airports.ts`, and Node-only for the same
 * reason.
 */
function loadCountries(from: string = import.meta.url): Record<string, string> {
  const beside = fileURLToPath(new URL('./countries.json', from))
  const raw = existsSync(beside)
    ? readFileSync(beside, 'utf8')
    : readFileSync(path.join(process.cwd(), 'src', 'intake', 'countries.json'), 'utf8')
  return JSON.parse(raw) as Record<string, string>
}

export const COUNTRIES: Record<string, string> = loadCountries()

/**
 * The country's name, or `null` for a code this table does not carry — never the code itself,
 * so a caller that would rather print "JP" than nothing has to say so. `hotelQuery`
 * (src/intake/places.ts) drops the country half of the query entirely instead, because
 * "hotels in Tokyo, JP" is a worse search string than "hotels in Tokyo".
 */
export function countryName(code: string): string | null {
  return COUNTRIES[code.trim().toUpperCase()] ?? null
}
