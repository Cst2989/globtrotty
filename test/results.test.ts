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
