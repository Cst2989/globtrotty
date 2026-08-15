import { describe, it, expect } from 'vitest'
import {
  money, addMoney, sumMoney, compareMoney, formatMoney,
  minorUnitExponent, CurrencyMismatchError,
} from '../src/money.js'

describe('minorUnitExponent', () => {
  it('is 2 for the common case', () => expect(minorUnitExponent('EUR')).toBe(2))
  it('is 0 for JPY', () => expect(minorUnitExponent('JPY')).toBe(0))
  it('is 3 for KWD', () => expect(minorUnitExponent('KWD')).toBe(3))
  it('rejects an unknown code', () => expect(() => minorUnitExponent('XYZ')).toThrow())
})

describe('money', () => {
  it('normalises a number to bigint', () => {
    expect(money(1412_00, 'EUR')).toEqual({ minor: 141200n, currency: 'EUR' })
  })
  it('rejects a non-integer amount', () => expect(() => money(10.5 as never, 'EUR')).toThrow())
  it('uppercases the currency', () => expect(money(1n, 'eur').currency).toBe('EUR'))
})

describe('currency safety', () => {
  it('refuses to add different currencies', () => {
    expect(() => addMoney(money(100n, 'EUR'), money(100n, 'GBP')))
      .toThrow(CurrencyMismatchError)
  })
  it('refuses to compare different currencies — the cashier bug', () => {
    // 1400 GBP is numerically less than 1500 EUR but costs more.
    expect(() => compareMoney(money(140000n, 'GBP'), money(150000n, 'EUR')))
      .toThrow(CurrencyMismatchError)
  })
  it('refuses to sum a mixed list', () => {
    expect(() => sumMoney([money(1n, 'EUR'), money(1n, 'USD')])).toThrow(CurrencyMismatchError)
  })
  it('refuses to sum an empty list, because the currency would be unknowable', () => {
    expect(() => sumMoney([])).toThrow()
  })
})

describe('arithmetic', () => {
  it('sums same-currency amounts', () => {
    expect(sumMoney([money(60000n, 'EUR'), money(80000n, 'EUR')]))
      .toEqual({ minor: 140000n, currency: 'EUR' })
  })
  it('does not overflow on large minor units', () => {
    const big = money(9_000_000_000n, 'IDR')     // > 2^31
    expect(addMoney(big, big).minor).toBe(18_000_000_000n)
  })
  it('compares correctly', () => {
    expect(compareMoney(money(100n, 'EUR'), money(200n, 'EUR'))).toBe(-1)
    expect(compareMoney(money(200n, 'EUR'), money(200n, 'EUR'))).toBe(0)
  })
})

describe('formatMoney', () => {
  it('renders 2-exponent currencies', () => expect(formatMoney(money(141200n, 'EUR'))).toContain('1,412'))
  it('renders 0-exponent currencies without decimals', () => {
    expect(formatMoney(money(1412n, 'JPY'))).not.toContain('.')
  })
})
