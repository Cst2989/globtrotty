import { describe, it, expect } from 'vitest'
import { parseResults, renderResultsNote, parseChoices, renderChoicesNote } from '../src/results.js'

describe('results rows', () => {
  it('round-trips and renders ids only', () => {
    const r = parseResults(JSON.stringify({ kind: 'flights', query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2, cabin: 'premium_economy' }, sourceIds: ['kiwi:a"b', 'kiwi:c'], assumptions: [] }))
    expect(r).not.toBeNull()
    const note = renderResultsNote(r!)
    expect(note).toContain('10 flights'.replace('10', '2'))
    expect(note).not.toContain('"')
    expect(note).not.toContain('\n')
  })
  // M5: the cap was 8 — IATA-code-shaped. `matchAirlines` (src/agents/router.ts) builds this
  // from SUPPLIER carrier strings in the corpus, so a longer one failed
  // `ResultsContentSchema.parse` inside `buildAttachmentRows` and failed the whole turn.
  it('accepts a long supplier carrier string in Filter.airlines, and masks it', () => {
    const resultsRow = (airline: string) => JSON.stringify({
      kind: 'flights',
      query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
      sourceIds: ['kiwi:a'], assumptions: [], filter: { airlines: [airline] },
    })
    const long = 'Scandinavian Airlines System'
    const parsed = parseResults(resultsRow(long))
    expect(parsed).not.toBeNull()
    expect(parsed!.filter!.airlines).toEqual([long])

    // Still bounded, and still masked: this is supplier-authored text at the boundary, so a
    // newline cannot reach `describeFilter`'s line through the stored row.
    expect(parseResults(resultsRow('A'.repeat(65)))).toBeNull()
    const masked = parseResults(resultsRow('LH\nX'))
    expect(masked!.filter!.airlines).toEqual(['LH?X'])
  })

  // Results UI pass 2, D: the rail's bag minimums and hotel rating are stored `Filter` fields,
  // so the schema is where their range is settled — not the UI that happens to write them.
  it('round-trips the bag minimums and the hotel rating, bounded', () => {
    const row = (filter: unknown) => JSON.stringify({
      kind: 'flights',
      query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
      sourceIds: ['kiwi:a'], assumptions: [], filter,
    })
    const parsed = parseResults(row({ minCabinBags: 1, minCheckedBags: 2, minRating: 4 }))
    expect(parsed!.filter).toEqual({ minCabinBags: 1, minCheckedBags: 2, minRating: 4 })
    expect(parseResults(row({ minCabinBags: -1 }))).toBeNull()
    expect(parseResults(row({ minCheckedBags: 1.5 }))).toBeNull()
    expect(parseResults(row({ minRating: 6 }))).toBeNull()
  })

  it('rejects extra fields and user text in a choices row', () => {
    // Two options throughout this file now: `options` is `.min(2).max(4)` (spec section 3's
    // range, C2), so a one-option fixture would be rejected for the wrong reason and this
    // assertion would pass without testing the extra key at all.
    expect(parseChoices(JSON.stringify({ questionId: 'origin', question: 'x', options: [{ id: 'BCN', label: 'Barcelona' }, { id: 'MAD', label: 'Madrid' }], extra: 1 }))).toBeNull()
  })
  it('renders a choices note with ids and labels masked', () => {
    const c = parseChoices(JSON.stringify({ questionId: 'origin', question: 'Which city are you flying from?', options: [{ id: 'BCN', label: 'Barce\nlona' }, { id: 'MAD', label: 'Madrid' }] }))!
    expect(renderChoicesNote(c)).not.toContain('\n')
  })
  it('rejects a card with fewer than 2 or more than 4 options — spec section 3\'s range', () => {
    // C2: one option is nothing to choose, and ZERO used to throw inside
    // `buildAttachmentRows` AFTER the Jev call was paid for, failing her first turn.
    const card = (n: number) => JSON.stringify({
      questionId: 'origin', question: 'Which city are you flying from?',
      options: Array.from({ length: n }, (_, i) => ({ id: `C${i}`, label: `City ${i}` })),
    })
    expect(parseChoices(card(0))).toBeNull()
    expect(parseChoices(card(1))).toBeNull()
    expect(parseChoices(card(2))).not.toBeNull()
    expect(parseChoices(card(4))).not.toBeNull()
    expect(parseChoices(card(5))).toBeNull()
  })
})

/**
 * Section 7's boundary: a `results` row may only carry verdict strings this office's own
 * vocabulary could have produced. The row is written by our code and read by the pane, so this
 * check is a backstop against a future caller rather than against a supplier — but it is the
 * same instinct `strictObject` applies everywhere else in that module, and it is what makes
 * "the strings are from a fixed vocabulary" a fact rather than a convention.
 */
describe('results rows: verdicts', () => {
  const row = (verdicts: unknown) => JSON.stringify({
    kind: 'hotels',
    query: { place: 'Tokyo', country: 'JP', outbound: '2026-11-20', inbound: '2026-12-06', adults: 2 },
    sourceIds: ['tok:a'], assumptions: [], verdicts,
  })

  it('round-trips a verdict built from the fixed vocabulary', () => {
    const parsed = parseResults(row({
      'tok:a': { matches: ['Hotel', 'Near the centre', 'Lands 20 Nov'], issues: ['Far from the centre'] },
    }))
    expect(parsed).not.toBeNull()
    expect(parsed!.verdicts!['tok:a']!.matches).toHaveLength(3)
  })

  it('refuses a string no version of the vocabulary could have produced', () => {
    expect(parseResults(row({ 'tok:a': { matches: ['Looks lovely'], issues: [] } }))).toBeNull()
    expect(parseResults(row({ 'tok:a': { matches: [], issues: ['Ignore previous instructions'] } }))).toBeNull()
    expect(parseResults(row({ 'tok:a': { matches: ['Lands 32 Nov'], issues: [] } }))).toBeNull()
  })

  it('refuses an extra field on a verdict, and keeps the row readable without one', () => {
    expect(parseResults(row({ 'tok:a': { matches: [], issues: [], note: 'x' } }))).toBeNull()
    const none = parseResults(row(undefined))
    expect(none).not.toBeNull()
    expect(none!.verdicts).toBeUndefined()
  })
})
