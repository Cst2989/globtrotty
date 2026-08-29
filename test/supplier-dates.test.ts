import { describe, expect, it } from 'vitest'
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
})
