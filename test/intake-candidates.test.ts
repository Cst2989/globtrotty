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

  // --- Fix round 1: cue and stoplist guards ---

  describe('fix round 1: exact/fuzzy place matches no longer fire on ordinary English words', () => {
    it.each([
      'nice to visit',
      'two male passengers',
      'split the bill',
      'bought some cologne',
      'la la la',
    ])('%s -> no place candidate', (text) => {
      expect(placeCandidates(text)).toEqual([])
    })

    it('parks on vacation -> no place candidate (fuzzy "parks"/"Paris" is one edit apart)', () => {
      expect(placeCandidates('parks on vacation')).toEqual([])
    })

    it('a cue word before the ambiguous name still resolves it', () => {
      expect(placeCandidates('to Nice').map((x) => x.code)).toContain('NCE')
      expect(placeCandidates('flying to Split').map((x) => x.code)).toContain('SPU')
    })

    it('a cued fuzzy misspelling still resolves', () => {
      expect(placeCandidates('to Barcelna').map((x) => x.code)).toContain('BCN')
    })
  })

  describe('fix round 1: month/weekday abbreviations no longer fire on ordinary English words', () => {
    it.each([
      'sun and warmth',
      'sat at the gate',
      'got wed',
    ])('%s -> no weekday', (text) => {
      expect(datePartCandidates(text).weekdays).toEqual([])
    })

    it('it may rain -> no month', () => {
      expect(datePartCandidates('it may rain').months).toEqual([])
    })

    it('we may visit 10 museums -> no month and no day', () => {
      const d = datePartCandidates('we may visit 10 museums')
      expect(d.months).toEqual([])
      expect(d.days).toEqual([])
    })

    it('a month abbreviation adjacent to a day number counts, in either order', () => {
      expect(datePartCandidates('nov 20').months).toContain('november')
      expect(datePartCandidates('20 nov').months).toContain('november')
    })

    it('a weekday abbreviation followed by a day number counts', () => {
      expect(datePartCandidates('sat 6th').weekdays).toContain('saturday')
    })
  })

  describe('fix round 1: upper-case codes that are also ordinary English words need a cue', () => {
    it('I WAS THERE -> no place candidate (shouted, uncued)', () => {
      expect(placeCandidates('I WAS THERE')).toEqual([])
    })

    it('fly to WAS -> resolves (cued)', () => {
      expect(placeCandidates('fly to WAS').map((x) => x.code)).toContain('WAS')
    })
  })

  describe('fix round 1: San Jose, Costa Rica is reachable by name', () => {
    it('plain "san jose" still resolves to the US airport (SJC)', () => {
      expect(placeCandidates('flying to san jose').map((x) => x.code)).toContain('SJC')
    })

    it('"san jose costa rica" resolves to SJO', () => {
      expect(placeCandidates('san jose costa rica').map((x) => x.code)).toContain('SJO')
    })
  })
})
