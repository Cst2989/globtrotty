import { nightsBetween, utcDayStart } from '../src/supplier/dates.js'

describe('nightsBetween', () => {
  it('counts nights across a normal range', () => {
    expect(nightsBetween('2026-09-12', '2026-09-19')).toBe(7)
  })

  it('is zero for a same-day range', () => {
    expect(nightsBetween('2026-09-12', '2026-09-12')).toBe(0)
  })

  it('throws RangeError on a malformed date', () => {
    expect(() => nightsBetween('not-a-date', '2026-09-19'))
      .toThrow(/nightsBetween: bad ISO date/)
  })

  // Not on main, and it asserts on the instant rather than on a night count.
  //
  // The suite pins TZ=America/Los_Angeles (vitest.config.ts). Under it, an
  // implementation that appended a bare 'T00:00:00' instead of 'T00:00:00Z',
  // or that mixed the two forms across the two ends, parses local midnight and
  // lands seven hours later than this. That is what this case fails on, and it
  // fails on it under any pinned zone that is not UTC.
  //
  // No night count can fail on it, which is why the case that used to sit here
  // was replaced rather than kept. nightsBetween rounds a span to whole days,
  // so a seven-hour skew at one end is 0.29 of a day and rounds away: the old
  // daylight-saving case returned 3 whether the parse was right or wrong, and
  // a reader who broke the function the way its comment described, which
  // LESSONS.md tells them to do, watched the suite stay green.
  it('parses a date to UTC midnight, not to the running process midnight', () => {
    expect(utcDayStart('2026-10-24')).toBe(Date.UTC(2026, 9, 24))
    // Spelled out once: this is what a local parse would have produced here,
    // and the number above is not it.
    expect(Date.parse('2026-10-24T00:00:00')).not.toBe(utcDayStart('2026-10-24'))
  })

  it('throws RangeError out of the parse itself', () => {
    expect(() => utcDayStart('2026-13-99')).toThrow(/nightsBetween: bad ISO date/)
  })
})
