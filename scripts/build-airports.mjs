#!/usr/bin/env node
// Builds src/intake/airports.json from OurAirports' airports.csv.
//
// What it is for: a flight card says "1 stop, Shanghai", not "1 stop, PVG".
// `LegSummary.route` (src/supplier/types.ts) carries the intermediate airports
// as bare IATA codes, and `src/intake/places.json` cannot answer this — that
// table is ~300 METRO areas keyed by metro code (SHA, TYO), deliberately
// curated, and a connection happens at an AIRPORT (PVG, HND), including plenty
// of airports no sane trip would ever start or end at. Two tables, two jobs.
//
// Kept: `large_airport` and `medium_airport` rows with `scheduled_service=yes`
// and an IATA code. A connection only ever happens somewhere with scheduled
// service, and the small-airport tier is tens of thousands of rows that cannot
// appear in a Kiwi itinerary.
//
// `city` is OurAirports' `municipality` with any trailing parenthetical
// dropped ("Shanghai (Pudong)" -> "Shanghai"). `name` is the airport name with
// the city prefix and the generic "International Airport" tail trimmed off, so
// "Shanghai Pudong International Airport" in "Shanghai" becomes "Pudong" — a
// terminal name worth printing beside a city, rather than the city said twice.
// See `shortName` for the fallbacks that keep that trim from ever returning
// nothing.
//
// Usage: node scripts/build-airports.mjs
// Writes: src/intake/airports.json

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', 'src', 'intake', 'airports.json')

const KEEP_TYPES = new Set(['large_airport', 'medium_airport'])

/** Minimal CSV line parser respecting double-quoted fields — the same one build-places.mjs uses. */
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

const GENERIC_TAIL = /[\s-]*(international|intl\.?|domestic|national|regional)?[\s-]*(airport|airfield|aerodrome|air\s*base|airpark)\s*$/i
const GENERIC_HEAD = /^(international\s+)?airport\s+/i

/**
 * OurAirports' `municipality` sometimes qualifies the city with the district or
 * province the airport physically sits in — "Shanghai (Pudong)",
 * "Paris (Roissy-en-France, Val-d'Oise)", "Helsinki (Vantaa)". A card says
 * "1 stop, Shanghai"; the parenthetical is exactly the detail that makes that
 * line worse, so it goes.
 */
function cityOf(municipality) {
  return municipality.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/**
 * "Shanghai Pudong International Airport" in "Shanghai" -> "Pudong"; never an
 * empty string.
 *
 * Three stages, each a fallback for the one before: drop the city prefix and
 * the generic tail; failing that (the airport is named after nothing but its
 * own city — "Dubai International Airport") drop only the tail, which leaves
 * the city itself; failing that, keep the raw name untouched.
 */
function shortName(name, city) {
  const tailless = name.replace(GENERIC_TAIL, '').trim()
  let short = tailless
  if (city && short.toLowerCase().startsWith(`${city.toLowerCase()} `)) {
    short = short.slice(city.length + 1)
  }
  short = short.replace(GENERIC_HEAD, '').replace(GENERIC_TAIL, '').trim()
  if (short.length > 0) return short
  return tailless.length > 0 ? tailless : name
}

function main() {
  return fetch(AIRPORTS_CSV_URL).then(async (res) => {
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const text = await res.text()
    const lines = text.split('\n').filter((l) => l.length > 0)
    const header = parseCsvLine(lines[0])
    const idx = Object.fromEntries(header.map((h, i) => [h, i]))
    for (const column of ['type', 'name', 'municipality', 'scheduled_service', 'iata_code']) {
      if (idx[column] === undefined) throw new Error(`airports.csv has no '${column}' column`)
    }

    const airports = {}
    let kept = 0
    let noMunicipality = 0
    for (const line of lines.slice(1)) {
      const f = parseCsvLine(line)
      const code = f[idx.iata_code]
      if (!code || code.length !== 3) continue
      if (!KEEP_TYPES.has(f[idx.type])) continue
      if (f[idx.scheduled_service] !== 'yes') continue
      const municipality = cityOf(f[idx.municipality] ?? '')
      const name = f[idx.name]
      if (!name) continue
      // No municipality means no city to print, which is the one thing this
      // table exists to answer — the airport name stands in for it rather than
      // the row being dropped, so "1 stop, <somewhere>" still names a place.
      if (!municipality) noMunicipality++
      // A duplicate IATA code in OurAirports means two rows claim it; the
      // first (large before medium is not guaranteed, so: first in file order)
      // wins, the same first-wins rule places.json uses for a shared code.
      if (airports[code] !== undefined) continue
      airports[code] = { city: municipality || shortName(name, ''), name: shortName(name, municipality) }
      kept++
    }

    const sorted = Object.fromEntries(Object.entries(airports).sort(([a], [b]) => a.localeCompare(b)))
    console.log(`${kept} airports kept (large/medium with scheduled service and an IATA code)`)
    if (noMunicipality > 0) console.log(`${noMunicipality} of them had no municipality; the airport name stands in`)
    console.log(`Writing ${OUT_PATH}`)
    writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n')
  })
}

main().catch((err) => { console.error(err); process.exit(1) })
