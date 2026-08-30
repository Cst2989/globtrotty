// ISO-4217 minor-unit exponents. Only non-2 values need listing.
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

// Currencies we accept. Extend deliberately; an unknown code must throw
// rather than silently default, because a wrong exponent is a 100x error.
const KNOWN = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'RON',
  'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'KWD', 'BHD', 'TND',
  'CAD', 'AUD', 'NZD', 'BRL', 'MXN', 'ZAR', 'TRY', 'AED',
])

declare const MoneyBrand: unique symbol
export type Money = { readonly minor: bigint; readonly currency: string; readonly [MoneyBrand]: true }

export class CurrencyMismatchError extends Error {
  constructor(readonly a: string, readonly b: string) {
    super(`Refusing to combine ${a} with ${b}. Convert deliberately or reject; never coerce.`)
    this.name = 'CurrencyMismatchError'
  }
}

export function minorUnitExponent(currency: string): number {
  const c = currency.toUpperCase()
  if (!KNOWN.has(c)) throw new Error(`Unknown currency: ${currency}`)
  return EXPONENTS[c] ?? 2
}

export function money(minor: bigint | number, currency: string): Money {
  const c = currency.toUpperCase()
  minorUnitExponent(c) // throws on unknown
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
    throw new Error(`Money must be whole minor units, got ${minor}`)
  }
  return { minor: BigInt(minor), currency: c } as Money
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency)
}

export function addMoney(a: Money, b: Money): Money {
  assertSame(a, b)
  return { minor: a.minor + b.minor, currency: a.currency } as Money
}

export function sumMoney(items: Money[]): Money {
  const first = items[0]
  if (!first) throw new Error('Cannot sum an empty list: the currency would be unknowable')
  return items.slice(1).reduce(addMoney, first) as Money
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b)
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0
}

/**
 * The display boundary: converting through a float here is fine because the
 * exact minor units travel beside this string wherever it matters (e.g.
 * `src/tools.ts`'s `itemForModel`), and this conversion is exact
 * below 2^53 minor units, which every currency here is nowhere near.
 */
export function formatMoney(m: Money): string {
  const exp = minorUnitExponent(m.currency)
  const value = Number(m.minor) / 10 ** exp
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(value)
}
