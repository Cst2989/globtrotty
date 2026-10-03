import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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

/** normalised alias/city string -> the place it resolves to. Built once from PLACES. */
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
