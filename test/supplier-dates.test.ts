import { nightsBetween } from '../src/supplier/dates.js'

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

  // Not on main. The suite pins TZ=America/Los_Angeles (vitest.config.ts), and
  // the whole reason this function parses with an explicit Z is that a
  // Date.parse of a bare 'yyyy-mm-dd' is UTC while a Date.parse of anything
  // with a time in it is local. An implementation that appended nothing, or
  // appended a local midnight, gets 7 here too by luck; one that mixes the two
  // ends does not.
  it('counts a range that spans a daylight-saving change as whole days', () => {
    // Europe/Lisbon leaves summer time on 25 October 2026.
    expect(nightsBetween('2026-10-24', '2026-10-27')).toBe(3)
  })
})
