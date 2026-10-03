import { describe, it, expect } from 'vitest'
import { resolveDate } from '../src/intake/dates.js'

const today = new Date('2026-10-03T12:00:00Z')
describe('resolveDate', () => {
  it('assumes the nearest future year when none is stated', () => {
    expect(resolveDate({ month: 'november', day: 20, year: null }, today)).toEqual({ iso: '2026-11-20', assumed: 'year' })
    expect(resolveDate({ month: 'march', day: 5, year: null }, today)).toEqual({ iso: '2027-03-05', assumed: 'year' })
  })
  it('keeps a date up to 30 days in the past in the current year (she may be mid-trip)', () => {
    expect(resolveDate({ month: 'september', day: 20, year: null }, today)!.iso).toBe('2026-09-20')
  })
  it('honours a stated year and rejects impossible dates', () => {
    expect(resolveDate({ month: 'february', day: 30, year: 2027 }, today)).toBeNull()
    expect(resolveDate({ month: 'december', day: 6, year: 2026 }, today)).toEqual({ iso: '2026-12-06', assumed: 'none' })
  })
  it('resolves a bare weekday to the next occurrence and "next" to the following week', () => {
    expect(resolveDate({ month: null, day: null, year: null, weekday: 'friday' }, today)!.iso).toBe('2026-10-09')
    expect(resolveDate({ month: null, day: null, year: null, weekday: 'friday', relative: 'next' }, today)!.iso).toBe('2026-10-16')
  })
})
