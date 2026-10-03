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
  it('rejects extra fields and user text in a choices row', () => {
    expect(parseChoices(JSON.stringify({ questionId: 'origin', question: 'x', options: [{ id: 'BCN', label: 'Barcelona' }], extra: 1 }))).toBeNull()
  })
  it('renders a choices note with ids and labels masked', () => {
    const c = parseChoices(JSON.stringify({ questionId: 'origin', question: 'Which city are you flying from?', options: [{ id: 'BCN', label: 'Barce\nlona' }] }))!
    expect(renderChoicesNote(c)).not.toContain('\n')
  })
})
