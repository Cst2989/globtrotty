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
// `country` is OurAirports' own `iso_country` (ISO 3166-1 alpha-2). `metro` is
// the `places.json` code this airport belongs to, or null — the hotels pass
// needs it because a chosen flight names its ARRIVAL AIRPORT ("NRT") and a
// hotel search needs the metro that airport serves ("TYO" -> "Tokyo", "JP").
// See `metroFor` for the three rules that resolve it and why they run in that
// order.
//
// Usage: node scripts/build-airports.mjs
// Writes: src/intake/airports.json

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', 'src', 'intake', 'airports.json')
const PLACES_PATH = path.join(__dirname, '..', 'src', 'intake', 'places.json')

const KEEP_TYPES = new Set(['large_airport', 'medium_airport'])

/**
 * Airport -> the `places.json` metro code it serves, for the cases NO rule
 * derived from the CSV can get right.
 *
 * A metro's SECONDARY airports sit in their own municipalities — Narita is a
 * city in Chiba, Newark is in New Jersey, Gatwick is in Crawley — so a
 * municipality match against the place table returns nothing for exactly the
 * airports a long-haul traveller actually lands at. This table is the IATA
 * metropolitan-area membership for the 22 metro entries `build-places.mjs`
 * curates (`METRO_PLACES` there), written out by hand because the dataset
 * carries no metro column at all.
 *
 * Deliberately NOT exhaustive in one direction: BWI is an IATA member of the
 * Washington metro area, and it is absent here because `places.json` carries
 * Baltimore as its own entry — landing at BWI should offer hotels in
 * Baltimore, not across the bay in Washington. ICN and GMP go the other way
 * (they ARE listed): `places.json` carries ICN as "Seoul-Incheon" for intake's
 * benefit, but nobody flying into Incheon wants hotels in Incheon, so the
 * metro wins there.
 */
const METRO_BY_AIRPORT = {
  // Tokyo
  HND: 'TYO', NRT: 'TYO',
  // London
  LHR: 'LON', LGW: 'LON', STN: 'LON', LTN: 'LON', LCY: 'LON', SEN: 'LON',
  // Paris
  CDG: 'PAR', ORY: 'PAR', BVA: 'PAR',
  // New York (BWI's counterpart EWR has no place entry of its own, so it maps)
  JFK: 'NYC', LGA: 'NYC', EWR: 'NYC',
  // Milan
  MXP: 'MIL', LIN: 'MIL', BGY: 'MIL',
  // Rome
  FCO: 'ROM', CIA: 'ROM',
  // Osaka (Kobe included: UKB is in the same metro)
  KIX: 'OSA', ITM: 'OSA', UKB: 'OSA',
  // Buenos Aires
  EZE: 'BUE', AEP: 'BUE',
  // Sao Paulo
  GRU: 'SAO', CGH: 'SAO', VCP: 'SAO',
  // Rio de Janeiro
  GIG: 'RIO', SDU: 'RIO',
  // Chicago
  ORD: 'CHI', MDW: 'CHI',
  // Washington (BWI deliberately absent — see this table's doc comment)
  IAD: 'WAS', DCA: 'WAS',
  // Moscow
  SVO: 'MOW', DME: 'MOW', VKO: 'MOW',
  // Istanbul
  IST: 'IST', SAW: 'IST',
  // Beijing
  PEK: 'BJS', PKX: 'BJS', NAY: 'BJS',
  // Shanghai (SHA is both the metro code and Hongqiao's own airport code)
  PVG: 'SHA', SHA: 'SHA',
  // Seoul
  ICN: 'SEL', GMP: 'SEL',
  // Bangkok
  BKK: 'BKK', DMK: 'BKK',
  // Jakarta
  CGK: 'JKT', HLP: 'JKT',
  // Taipei
  TPE: 'TPE', TSA: 'TPE',
  // Stockholm
  ARN: 'STO', BMA: 'STO', NYO: 'STO', VST: 'STO',
}

/** `src/intake/places.ts`'s own `normalise`, repeated here because a build script cannot import TypeScript. */
function normalise(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * The place table, as the two lookups `metroFor` needs: the set of codes it
 * carries, and normalised city/alias -> code (first wins, matching
 * `ALIAS_MAP`'s own rule in src/intake/places.ts so the two tables never
 * disagree about which place a shared name resolves to).
 */
function loadPlaceIndex() {
  const places = JSON.parse(readFileSync(PLACES_PATH, 'utf8'))
  const codes = new Set(places.map((p) => p.code))
  const byName = new Map()
  for (const p of places) {
    for (const key of [p.city, ...p.aliases]) {
      const norm = normalise(key)
      if (norm && !byName.has(norm)) byName.set(norm, p.code)
    }
  }
  return { codes, byName }
}

/**
 * Three rules, in this order:
 *
 *  1. `METRO_BY_AIRPORT` — the hand-written membership above. First because it
 *     is the only rule that knows a metro exists at all, and because the two
 *     entries it deliberately overrides (ICN, SHA) are codes rule 2 would
 *     otherwise answer with the wrong place.
 *  2. The airport's own code IS a place code — every single-airport city in
 *     `places.json` (AGP, BCN, FAO) is keyed on exactly this code.
 *  3. A municipality match — catches a secondary airport that happens to sit
 *     in the metro's own municipality (London Luton's municipality is
 *     "London") and a place whose code is some other airport in the same city.
 *
 * `null` otherwise, and null is the honest answer for most of the 3,000-odd
 * rows here: `places.json` is ~300 metros on purpose, and a flight into an
 * airport it does not cover has no city this product can name hotels in. The
 * caller (`placeForAirport`) treats null as "unknown", never as a licence to
 * search for the bare code — which is the hotels pass's bug 0.
 */
function metroFor(code, municipality, index) {
  const explicit = METRO_BY_AIRPORT[code]
  if (explicit) return index.codes.has(explicit) ? explicit : null
  if (index.codes.has(code)) return code
  const byName = municipality ? index.byName.get(normalise(municipality)) : undefined
  return byName ?? null
}

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
    for (const column of ['type', 'name', 'municipality', 'scheduled_service', 'iata_code', 'iso_country']) {
      if (idx[column] === undefined) throw new Error(`airports.csv has no '${column}' column`)
    }

    const index = loadPlaceIndex()
    const airports = {}
    let kept = 0
    let noMunicipality = 0
    let withMetro = 0
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
      const metro = metroFor(code, municipality, index)
      if (metro) withMetro++
      airports[code] = {
        city: municipality || shortName(name, ''),
        name: shortName(name, municipality),
        // Upper-cased for the same reason every other code here is: nothing
        // downstream should have to guess the case of a table's own keys.
        country: (f[idx.iso_country] ?? '').trim().toUpperCase() || null,
        metro,
      }
      kept++
    }

    const sorted = Object.fromEntries(Object.entries(airports).sort(([a], [b]) => a.localeCompare(b)))
    console.log(`${kept} airports kept (large/medium with scheduled service and an IATA code)`)
    if (noMunicipality > 0) console.log(`${noMunicipality} of them had no municipality; the airport name stands in`)
    console.log(`${withMetro} resolved to a places.json metro; the rest carry metro: null`)
    for (const [airport, metro] of Object.entries(METRO_BY_AIRPORT)) {
      if (airports[airport] === undefined) console.warn(`  - METRO_BY_AIRPORT names ${airport} (${metro}), which this dataset has no row for`)
    }
    console.log(`Writing ${OUT_PATH}`)
    writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n')
  })
}

main().catch((err) => { console.error(err); process.exit(1) })
