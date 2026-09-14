import { COMPLEX_NIGHTS, difficultyOf } from '../src/loop/difficulty.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'

const stated = <T>(value: T) => ({ value, source: 'user' as const, at: '2026-09-14T10:00:00Z' })

describe('trip difficulty', () => {
  it('is null when the row predates the snapshot column', () => {
    // Not 'simple'. A row we cannot classify is a row the ranking leaves out,
    // and calling it simple would quietly fill the easy segment with every
    // proposal this branch wrote before module 6.
    expect(difficultyOf(null)).toBeNull()
  })

  it('calls her Portugal trip complex, because of the toddler', () => {
    const notebook: Notebook = {
      ...emptyNotebook(),
      destination: stated('Faro'),
      partySize: stated({ adults: 2, children: 1, infants: 0 }),
    }
    expect(difficultyOf(notebook)).toBe('complex')
  })

  it('calls a two-field weekend simple', () => {
    const notebook: Notebook = {
      ...emptyNotebook(), destination: stated('Faro'), nights: stated(3),
    }
    expect(difficultyOf(notebook)).toBe('simple')
  })

  it('turns complex at the night boundary and not before it', () => {
    const at = (nights: number): Notebook => ({ ...emptyNotebook(), nights: stated(nights) })
    expect(difficultyOf(at(COMPLEX_NIGHTS))).toBe('simple')
    expect(difficultyOf(at(COMPLEX_NIGHTS + 1))).toBe('complex')
  })
})
