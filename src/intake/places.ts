import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AIRPORTS } from './airports.js'
import { countryName } from './countries.js'

export type Region = 'europe' | 'north_america' | 'asia' | 'oceania' | 'africa' | 'south_america' | 'middle_east'

/**
 * A metro/airport entry in the bundled place table (`places.json`). `hotelName` is what hotel
 * searches use (ledger ruling 3): it defaults to `city` for every ordinary entry, but Kyoto has
 * no airport of its own and is modelled as a second entry sharing Osaka's metro `code`, with
 * `hotelName: 'Kyoto'` so a hotel search for "Kyoto" doesn't search hotels in Osaka.
 * `longHaulFrom` is an optional escape hatch for a specific origin/destination pair that should
 * (or should not) count as long haul even though `isLongHaul` normally derives this from
 * `region` alone; no entry in the bundled table uses it yet.
 */
export type Place = {
  code: string
  city: string
  country: string
  region: Region
  hotelName: string
  longHaulFrom?: string[]
  aliases: string[]
  /**
   * The city's own coordinates, geocoded once at build time (Nominatim, cached in
   * scripts/.cache/geocode.json — see scripts/build-places.mjs). This is what "3.2 km from
   * centre" on a hotel card is measured from. `null` for a place Nominatim could not answer
   * for, and a null means the distance is not shown at all rather than shown as zero.
   */
  center: { lat: number; lon: number } | null
}

/**
 * `places.json` ships as a file so a reviewable diff shows exactly which metro/alias changed
 * (same reasoning as `loadPrompt` in src/agents/prompts/load.ts). Two candidate paths, same two
 * reasons: beside this module when nothing has repackaged the source tree (tsx, vitest, a plain
 * Next.js render), or repo-relative from `process.cwd()` inside a bundled function.
 */
function loadPlaces(from: string = import.meta.url): Place[] {
  const beside = fileURLToPath(new URL('./places.json', from))
  const raw = existsSync(beside) ? readFileSync(beside, 'utf8') : readFileSync(path.join(process.cwd(), 'src', 'intake', 'places.json'), 'utf8')
  return JSON.parse(raw) as Place[]
}

export const PLACES: Place[] = loadPlaces()

/** Lowercases, strips accents (NFD + combining marks) and punctuation, collapses whitespace. */
export function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * normalised alias/city string -> the place it resolves to. Built once from PLACES, first
 * occurrence wins (places.json's sort-by-code order). This matters whenever two places share a
 * `city` string: San Jose, US (`SJC`) sorts before San Jose, Costa Rica (`SJO`), so the bare key
 * "san jose" resolves to SJC and SJO is otherwise unreachable by name -- which is why SJO carries
 * its own disambiguating aliases ("san jose costa rica", "san josé costa rica") in places.json,
 * added by `ALIASES_BY_CODE` in scripts/build-places.mjs rather than the city-keyed alias list
 * (keying by city would collide with SJC's entry). A future second collision needs the same
 * treatment: give the entry that loses the bare name a code-keyed alias that disambiguates it.
 */
export const ALIAS_MAP: Map<string, Place> = (() => {
  const map = new Map<string, Place>()
  for (const p of PLACES) {
    const keys = [p.city, ...p.aliases]
    for (const key of keys) {
      const norm = normalise(key)
      if (norm && !map.has(norm)) map.set(norm, p)
    }
  }
  return map
})()

/**
 * code -> the canonical place for that code. Several places can share a code (Osaka/Kyoto both
 * carry `OSA`); the first one encountered in `places.json`'s order wins, which is Osaka (the
 * build script keeps the Kyoto alias entry last for exactly this reason).
 */
export const CODE_MAP: Map<string, Place> = (() => {
  const map = new Map<string, Place>()
  for (const p of PLACES) if (!map.has(p.code)) map.set(p.code, p)
  return map
})()

const REGION_BY_CODE: Map<string, Region> = (() => {
  const map = new Map<string, Region>()
  for (const p of PLACES) if (!map.has(p.code)) map.set(p.code, p.region)
  return map
})()

/** Long haul is derived: different region implies long haul. Unknown codes are never long haul. */
export function isLongHaul(from: string, to: string): boolean {
  const a = REGION_BY_CODE.get(from)
  const b = REGION_BY_CODE.get(to)
  if (!a || !b) return false
  return a !== b
}

/**
 * The metro a flight's ARRIVAL AIRPORT serves, or `null`.
 *
 * The hotels pass's bug 0: `handleChoose` derives the destination from the chosen flight's
 * arrival airport code, and `CODE_MAP` is keyed on METRO codes. `CODE_MAP.get('NRT')` is
 * therefore `undefined`, and the fallback sent the bare code to the supplier — a hotel search
 * for `q=NRT`, which is how a Tokyo trip came back with vacation rentals in the United States.
 * `airports.json` now carries the metro each airport belongs to (scripts/build-airports.mjs's
 * `metroFor`), so this resolves NRT to the Tokyo entry.
 *
 * `null` for an airport the table does not place, and the caller must treat that as "no hotel
 * search is possible here" rather than falling back to the code: the bare code is not a place
 * name, and sending it to a hotel engine is worse than not searching, because the answer looks
 * like results.
 */
export function placeForAirport(code: string): Place | null {
  const metro = AIRPORTS[code.trim().toUpperCase()]?.metro ?? null
  if (metro === null) return null
  return CODE_MAP.get(metro) ?? null
}

/**
 * The place one of this table's OWN names resolves to — `ALIAS_MAP`'s lookup, exposed as a
 * function so callers do not each repeat the `normalise` step.
 *
 * The caller the hotels pass added is `handleRefresh` (src/agents/refresh.ts): a stored hotels
 * row carries the `hotelName` it searched for, and the refresh needs that place's `center` back
 * to recompute each stay's distance from the centre. Still this table's own string on both
 * sides — the row was written from `Place.hotelName` in the first place.
 */
export function placeByName(name: string): Place | null {
  const norm = normalise(name)
  return norm === '' ? null : ALIAS_MAP.get(norm) ?? null
}

/**
 * The place a flight leg's endpoint means, whether that endpoint is an airport code (what
 * `LegSummary.from`/`to` carry) or already a metro code (what a stored `results` row's query
 * carries). Airport first: `SHA` and `IST` are both, and the airport table's own answer for
 * them is the metro anyway.
 */
export function placeForCode(code: string): Place | null {
  return placeForAirport(code) ?? CODE_MAP.get(code.trim().toUpperCase()) ?? null
}

/**
 * What a hotel search sends as its `q`. Verified live on 2026-10-04: `q=Tokyo` returns random
 * US vacation rentals from SearchApi's `google_hotels` engine, while
 * `q=hotels in Tokyo, Japan` with `gl=jp` returns real Tokyo hotels. The engine is a
 * natural-language search, not a place-id lookup, so the words matter.
 *
 * Both halves come from this repo's own tables (`Place.hotelName`, `countries.json`) — never
 * from a supplier's string and never from her typed message.
 */
export function hotelQuery(hotelName: string, countryCode: string | null): string {
  const country = countryCode === null ? null : countryName(countryCode)
  return country === null ? `hotels in ${hotelName}` : `hotels in ${hotelName}, ${country}`
}

const EARTH_RADIUS_KM = 6371

const toRadians = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance in km, rounded to one decimal — the figure a card prints as
 * "3.2 km from centre".
 *
 * A haversine rather than a flat-earth approximation because this is also used at long range
 * (an airport 70 km out of town), and rounded here rather than at the renderer so the stored
 * corpus value and the rendered one can never disagree.
 */
export function haversineKm(
  a: { lat: number; lon: number }, b: { lat: number; lon: number },
): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10
}
