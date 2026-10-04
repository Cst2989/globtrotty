import { describe, it, expect } from 'vitest'
import {
  money, addMoney, sumMoney, compareMoney, formatMoney, formatMoneyShort,
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
  it('rejects unsafe integers that have lost precision', () => {
    expect(() => money(2 ** 53 + 1, 'EUR')).toThrow()
  })
  it('uppercases the currency', () => expect(money(1n, 'eur').currency).toBe('EUR'))
  it('prevents hand-built objects that bypass validation', () => {
    // @ts-expect-error — Money has a brand; this literal cannot satisfy the type
    const handBuilt: Money = { minor: 100n, currency: 'ZZZ' }
    // If this line compiles, the brand is broken and this test fails the build
    void handBuilt
  })
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
  it('renders 3-exponent currencies with three fraction digits', () => {
    const formatted = formatMoney(money(141200n, 'KWD'))
    expect(formatted).toContain('141.2')
  })
})

/**
 * Trip-stage pass, section 4. Every price on a card, a tab, a pin, a summary bar and a totals
 * block drops a whole-number fraction: `.00` on a four-figure number is two characters of noise
 * on the figure a traveller is actually comparing. A REAL fraction is never hidden.
 */
describe('formatMoneyShort', () => {
  it('drops a whole-number fraction and keeps a real one', () => {
    expect(formatMoneyShort(money(324800n, 'EUR'))).toBe('€3,248')
    expect(formatMoneyShort(money(1250n, 'EUR'))).toBe('€12.50')
    expect(formatMoneyShort(money(1200n, 'EUR'))).toBe('€12')
    expect(formatMoneyShort(money(0n, 'EUR'))).toBe('€0')
    expect(formatMoneyShort(money(1n, 'EUR'))).toBe('€0.01')
  })

  it('leaves a zero-exponent currency exactly as `formatMoney` does', () => {
    expect(formatMoneyShort(money(5400n, 'JPY'))).toBe(formatMoney(money(5400n, 'JPY')))
  })

  it('never changes what `formatMoney` itself says', () => {
    expect(formatMoney(money(324800n, 'EUR'))).toBe('€3,248.00')
  })
})
