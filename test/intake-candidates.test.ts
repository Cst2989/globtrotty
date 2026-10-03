import { describe, it, expect } from 'vitest'
import { placeCandidates, datePartCandidates, countCandidates } from '../src/intake/candidates.js'
import { isLongHaul } from '../src/intake/places.js'

const MSG = 'i need to be in tokio with my wife on 20th of nov, from barcelona, and back in barcelona sunday 6th of december. i will also travel in kioto, nintendo museum on the 3rd'

describe('candidates', () => {
  it('finds misspelled and local place names with their spans', () => {
    const p = placeCandidates(MSG)
    expect(p.map((x) => x.code)).toEqual(expect.arrayContaining(['TYO', 'BCN', 'OSA']))
    expect(p.find((x) => x.code === 'TYO')!.span).toBe('tokio')
  })

  it('finds date parts without doing calendar math', () => {
    const d = datePartCandidates(MSG)
    expect(d.days).toEqual(expect.arrayContaining([20, 6, 3]))
    expect(d.months).toEqual(expect.arrayContaining(['november', 'december']))
    expect(d.weekdays).toEqual(['sunday'])
    expect(d.years).toEqual([])
  })

  it('reads party hints', () => {
    expect(countCandidates('two of us')).toContain(2)
    expect(countCandidates(MSG)).toContain(2) // "my wife" implies 2
  })

  it('knows Barcelona to Tokyo is long haul and Tokyo to Osaka is not', () => {
    expect(isLongHaul('BCN', 'TYO')).toBe(true)
    expect(isLongHaul('TYO', 'OSA')).toBe(false)
  })

  // --- Task 2 extra coverage: the fuzzy rule and the upper-case-only code rule ---

  it('fuzzy-matches a 5+ letter misspelling even when not a listed alias (Damerau-Levenshtein <= 1)', () => {
    // "Barcelna" (one letter dropped) is not in the alias list; distance to "barcelona" is 1.
    const p = placeCandidates('thinking about a trip to barcelna next spring')
    expect(p.map((x) => x.code)).toContain('BCN')
  })

  it('never fuzzy-matches a 3-letter code, and never matches a code written in lower/mixed case', () => {
    // "bcn" lower-case is 3 letters: too short for the fuzzy rule, and not upper-case, so it
    // must not resolve to Barcelona through either mechanism.
    const lower = placeCandidates('see you in bcn next week')
    expect(lower.map((x) => x.code)).not.toContain('BCN')

    // The same token written upper-case DOES resolve, through the explicit code rule.
    const upper = placeCandidates('see you in BCN next week')
    expect(upper.map((x) => x.code)).toContain('BCN')
  })

  it('does not treat a bare day number as a date unless it sits near a month name or "of"', () => {
    const near = datePartCandidates('let us meet on 15 november in the city')
    expect(near.days).toContain(15)

    const far = datePartCandidates('i booked 15 tickets for the whole group, unrelated to any date')
    expect(far.days).not.toContain(15)
  })
})
