#!/usr/bin/env node
// Builds src/intake/airlines.json from OpenFlights' airlines.dat.
//
// Why a committed file rather than a lookup at render time: the only thing
// this table does is turn a carrier code a SUPPLIER put in the corpus ("MU")
// into the name a human reads ("China Eastern Airlines") and the `alt` text of
// the logo on a flight card. That must never depend on a third-party request
// completing while a page renders, and a reviewable diff showing exactly which
// carrier changed is worth more than freshness here — the same reasoning
// `scripts/build-places.mjs` records for places.json.
//
// Kept: rows OpenFlights marks active (`"Y"`) that carry a two-character IATA
// code. Everything else — defunct carriers, three-letter ICAO-only rows, the
// `-`/`N/A`/`\N` placeholders OpenFlights uses for "no code" — is dropped,
// because a code that cannot appear in a Kiwi itinerary has no business in a
// lookup table this is the only consumer of.
//
// Collisions: IATA reassigns a two-letter code once a carrier folds, and
// OpenFlights keeps both rows. Only ACTIVE rows reach this map, so a collision
// between two active carriers is a genuine data question, not a historical
// one: the FIRST row wins (OpenFlights' own id order, oldest first) and every
// collision is printed, so a wrong pick is visible rather than silent.
//
// Usage: node scripts/build-airlines.mjs
// Writes: src/intake/airlines.json

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AIRLINES_DAT_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', 'src', 'intake', 'airlines.json')

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

/** OpenFlights writes an absent value as `\N`; it also uses `-` and `N/A` for "no code". */
const PLACEHOLDERS = new Set(['\\N', '-', 'N/A', ''])

// Hand-resolved codes, applied unconditionally after the scan — the same kind
// of curated override `scripts/build-places.mjs` keeps for its own alias
// collisions, and for the same reason: the dataset is stale on a handful of
// rows and a wrong name here is read by a traveller on every card.
//
// Each entry is a code where OpenFlights' `active` flag is wrong about which
// carrier holds it TODAY. Verified against the collision report this script
// prints; a code not listed here keeps whatever the scan found.
//   G3  OpenFlights keeps City Connexion (Burundi, gone) and Sky Express
//       (Greece, now GQ) as active holders; G3 is Gol's.
//   VY  Formosa Airlines (Taiwan, gone 1999) still flagged active; VY has been
//       Vueling's since 2004, and Vueling flies out of this product's own
//       demo origin.
//   D8  Djibouti Airlines (gone) is OpenFlights' only active D8; D8 is
//       Norwegian's European arm.
//   XP  OpenFlights' only active XP is "XPTO", which is Portuguese for "foo" —
//       a placeholder row, not an airline. XP is Avelo's.
const PREFERRED_BY_CODE = {
  G3: 'Gol Transportes Aéreos',
  VY: 'Vueling Airlines',
  D8: 'Norwegian Air International',
  XP: 'Avelo Airlines',
}

const IATA_CODE = /^[A-Z0-9]{2}$/

/**
 * OpenFlights carries a handful of rows whose "name" is not a name: a single
 * letter, a bare number, or the code repeated back ("ZZ" -> "Zz"). Showing one
 * of those as the operating carrier on a €2,657 card is worse than showing the
 * code, which is exactly what the card falls back to when this table has no
 * entry — so they are dropped rather than kept.
 */
function isUsableName(code, name) {
  if (name.trim().length < 2) return false
  if (/^[\d\s]+$/.test(name)) return false
  if (name.trim().toUpperCase() === code.toUpperCase()) return false
  return true
}

function main() {
  return fetch(AIRLINES_DAT_URL).then(async (res) => {
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const text = await res.text()

    // airlines.dat has NO header row: id, name, alias, iata, icao, callsign, country, active.
    const names = {}
    const collisions = []
    let active = 0
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      const f = parseCsvLine(line)
      const [, name, , iata, , , , isActive] = f
      if (isActive !== 'Y') continue
      active++
      // `IATA_CODE` is ASCII-only on purpose: OpenFlights has rows keyed on
      // Cyrillic look-alikes ("МИ"), which no supplier can ever send.
      if (!iata || PLACEHOLDERS.has(iata) || !IATA_CODE.test(iata)) continue
      if (!name || PLACEHOLDERS.has(name) || !isUsableName(iata, name)) continue
      if (names[iata] !== undefined) {
        if (names[iata] !== name) collisions.push(`${iata}: kept "${names[iata]}", dropped "${name}"`)
        continue
      }
      names[iata] = name
    }

    if (collisions.length > 0) {
      console.warn(`\n${collisions.length} active-carrier IATA collision(s), first row kept:`)
      for (const c of collisions) console.warn(`  - ${c}`)
    }

    for (const [code, name] of Object.entries(PREFERRED_BY_CODE)) {
      if (names[code] === name) console.warn(`  - note: the override for ${code} now matches the dataset; it can be dropped`)
      names[code] = name
    }

    const sorted = Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)))
    console.log(`\n${active} active rows; ${Object.keys(sorted).length} with a 2-char IATA code`)
    console.log(`Writing ${OUT_PATH}`)
    writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n')
  })
}

main().catch((err) => { console.error(err); process.exit(1) })
