import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export type Airport = {
  city: string
  name: string
  /** ISO 3166-1 alpha-2, straight from OurAirports' `iso_country`; `null` for a row without one. */
  country: string | null
  /**
   * The `places.json` code this airport belongs to, or `null` for an airport that table does not
   * cover. `metroFor` in scripts/build-airports.mjs derives it (three rules, documented there);
   * `placeForAirport` (src/intake/places.ts) is what reads it, and it is the whole reason a
   * flight into NRT can now search hotels in Tokyo instead of hotels in "NRT".
   */
  metro: string | null
}

/**
 * Airport code -> `{ city, name }`, from `airports.json` (built by
 * `scripts/build-airports.mjs` out of OurAirports' airports.csv — large and medium airports with
 * scheduled service).
 *
 * This answers "where does this flight stop": `LegSummary.route` carries the intermediate
 * airports as bare IATA codes and a card reads "1 stop, Shanghai", not "1 stop, PVG".
 * `src/intake/places.ts` deliberately cannot answer it — that table is ~300 curated METRO areas
 * keyed on metro codes (SHA, TYO) for intake to search from, and a connection happens at an
 * AIRPORT. Two tables, two jobs; neither grows into the other.
 *
 * Same file-read-at-import posture as `places.ts`/`airlines.ts`, and Node-only for the same
 * reason: `web/data.ts` resolves the city names server-side into
 * `ResultItemLite.flight.outbound.viaCities`.
 */
function loadAirports(from: string = import.meta.url): Record<string, Airport> {
  const beside = fileURLToPath(new URL('./airports.json', from))
  const raw = existsSync(beside)
    ? readFileSync(beside, 'utf8')
    : readFileSync(path.join(process.cwd(), 'src', 'intake', 'airports.json'), 'utf8')
  return JSON.parse(raw) as Record<string, Airport>
}

export const AIRPORTS: Record<string, Airport> = loadAirports()

/**
 * The city an airport serves, or `null` when the table does not know the code — never the code
 * itself, so a caller that wants "1 stop, PVG" as a fallback has to say so.
 */
export function airportCity(code: string): string | null {
  return AIRPORTS[code.trim().toUpperCase()]?.city ?? null
}

/** The airport's own short name ("Pudong", "Heathrow"), or `null` for a code the table lacks. */
export function airportName(code: string): string | null {
  return AIRPORTS[code.trim().toUpperCase()]?.name ?? null
}

/**
 * The airport's own ISO 3166-1 alpha-2 country, or `null` for a code the table lacks OR whose
 * own `country` is `null` (a handful of OurAirports rows carry neither). The connections filter
 * (`applyFilter`, src/intake/filter.ts; `applyFilterLite`'s mirror reads it off `LegLite.
 * viaCountries`, resolved here server-side in web/data.ts) treats both cases the same way: an
 * airport this table cannot place by country is never excluded by `avoidCountries`/
 * `avoidRegions`, rather than guessed at.
 */
export function airportCountry(code: string): string | null {
  return AIRPORTS[code.trim().toUpperCase()]?.country ?? null
}
