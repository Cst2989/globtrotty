// Results UI pass 2, C. The two bundled lookup tables a flight card reads through
// `web/data.ts`: carrier code -> airline name, airport code -> city. Both ship as committed
// JSON (scripts/build-airlines.mjs, scripts/build-airports.mjs) so a reviewable diff shows
// exactly which row changed, and these are the pins that make a bad rebuild fail loudly.
import { describe, expect, it } from 'vitest'
import { AIRLINES, airlineName } from '../src/intake/airlines.js'
import { AIRPORTS, airportCity, airportName } from '../src/intake/airports.js'

describe('airlineName', () => {
  it('names the carriers this product actually sees', () => {
    expect(airlineName('QR')).toBe('Qatar Airways')
    expect(airlineName('MU')).toBe('China Eastern Airlines')
    expect(airlineName('FR')).toBe('Ryanair')
    expect(airlineName('U2')).toBe('easyJet')
  })

  // The build script's own hand-resolved codes: OpenFlights still flags the defunct holder of
  // each of these as active, and Vueling in particular flies out of this product's demo origin.
  it('keeps the hand-resolved codes resolved', () => {
    expect(airlineName('VY')).toBe('Vueling Airlines')
    expect(airlineName('G3')).toBe('Gol Transportes Aéreos')
    expect(airlineName('D8')).toBe('Norwegian Air International')
  })

  it('upper-cases on the way in, since nothing guarantees what a supplier sends', () => {
    expect(airlineName('qr')).toBe('Qatar Airways')
    expect(airlineName(' qr ')).toBe('Qatar Airways')
  })

  it('returns null for an unknown code rather than echoing it back', () => {
    expect(airlineName('ZZ')).toBeNull()
    expect(airlineName('')).toBeNull()
  })

  it('carries no row whose "name" is a placeholder, a bare number or the code repeated', () => {
    const junk = Object.entries(AIRLINES).filter(([code, name]) =>
      name.trim().length < 2 || /^[\d\s]+$/.test(name) || name.trim().toUpperCase() === code)
    expect(junk).toEqual([])
    expect(Object.keys(AIRLINES).every((code) => /^[A-Z0-9]{2}$/.test(code))).toBe(true)
  })
})

describe('airportCity / airportName', () => {
  it('names the city a connection airport serves, not the airport', () => {
    expect(airportCity('PVG')).toBe('Shanghai')
    expect(airportCity('DOH')).toBe('Doha')
    expect(airportCity('LHR')).toBe('London')
    expect(airportCity('CDG')).toBe('Paris')
  })

  it('drops the district parenthetical OurAirports qualifies some municipalities with', () => {
    // "Shanghai (Pudong)", "Paris (Roissy-en-France, Val-d'Oise)", "Helsinki (Vantaa)".
    expect(airportCity('HEL')).toBe('Helsinki')
    for (const code of Object.keys(AIRPORTS)) expect(AIRPORTS[code]!.city).not.toContain('(')
  })

  it('keeps the airport\'s own short name beside the city', () => {
    expect(airportName('PVG')).toBe('Pudong')
    expect(airportName('LHR')).toBe('Heathrow')
    expect(airportName('HND')).toBe('Haneda')
  })

  it('returns null for an unknown code', () => {
    expect(airportCity('ZZZ')).toBeNull()
    expect(airportName('ZZZ')).toBeNull()
  })

  it('covers every airport a connection can happen at, keyed on a 3-letter code', () => {
    expect(Object.keys(AIRPORTS).length).toBeGreaterThan(2000)
    expect(Object.keys(AIRPORTS).every((code) => /^[A-Z0-9]{3}$/.test(code))).toBe(true)
    for (const code of Object.keys(AIRPORTS)) {
      expect(AIRPORTS[code]!.city.length).toBeGreaterThan(0)
      expect(AIRPORTS[code]!.name.length).toBeGreaterThan(0)
    }
  })
})
