import { money } from '../src/money.js'
import { itemTotal, isFlight, isHotel } from '../src/supplier/types.js'
import type { SupplierItem } from '../src/supplier/types.js'

const flight = (over: Partial<SupplierItem> = {}): SupplierItem => ({
  sourceId: 'K1', supplier: 'kiwi', kind: 'flight', name: 'BER-FAO',
  price: money(45400n, 'EUR'), priceBasis: 'total',
  fetchedAt: new Date('2026-08-16T10:00:00Z'), ttlSeconds: 900,
  bookingUrl: 'https://kiwi.com/u/abc',
  detail: {
    kind: 'flight',
    outbound: { from: 'BER', to: 'FAO', departureLocal: '2026-09-12T16:40:00',
                arrivalLocal: '2026-09-12T23:30:00', stops: 1,
                route: ['BER', 'STN', 'FAO'], cabinClass: 'Economy', carriers: ['FR'],
                flightNumbers: ['FR1762', 'FR875'] },
    inbound: null,
    baggage: { personalItem: 2, cabinBag: 0, checkedBag: 0 },
    totalDurationSeconds: 28200, selfTransfer: true,
  },
  ...over,
})

describe('itemTotal', () => {
  it('multiplies price by quantity in minor units', () => {
    expect(itemTotal(flight(), 3).minor).toBe(136200n)
  })

  it('rejects a non-integer or non-positive quantity', () => {
    expect(() => itemTotal(flight(), 0)).toThrow(/quantity/i)
    expect(() => itemTotal(flight(), -1)).toThrow(/quantity/i)
    expect(() => itemTotal(flight(), 1.5)).toThrow(/quantity/i)
  })

  it('preserves the currency', () => {
    expect(itemTotal(flight({ price: money(100n, 'GBP') }), 2).currency).toBe('GBP')
  })

  it('does not lose precision on a large quantity', () => {
    // A float path would go inexact well before this.
    expect(itemTotal(flight({ price: money(999999999n, 'EUR') }), 9999).minor)
      .toBe(999999999n * 9999n)
  })
})

describe('kind narrowing', () => {
  it('discriminates flight from hotel on detail.kind', () => {
    const f = flight()
    expect(isFlight(f)).toBe(true)
    expect(isHotel(f)).toBe(false)
    if (isFlight(f)) expect(f.detail.outbound.route).toEqual(['BER', 'STN', 'FAO'])
  })

  // Not on main. `SupplierItem` does not couple `kind` and `detail.kind`, and
  // from lesson 4.3 the corpus reads `detail` back as unvalidated jsonb, so a
  // row where the two disagree is possible. Every gate that asks "what is
  // this?" must ask the same field, and this pins which one that is: the
  // narrowing keys off `detail.kind`, never off the sibling `kind`.
  it('keys off detail.kind, not the sibling kind field', () => {
    const spoofed = flight({ kind: 'hotel' })
    expect(isFlight(spoofed)).toBe(true)
    expect(isHotel(spoofed)).toBe(false)
  })
})

describe('DEFAULT_MAX_AGE_SECONDS', () => {
  it('is one number two suppliers share, not two literals that agree today', async () => {
    const { DEFAULT_MAX_AGE_SECONDS } = await import('../src/supplier/types.js')
    const { mockSuppliers } = await import('../src/supplier/mock.js')
    expect(DEFAULT_MAX_AGE_SECONDS).toBe(900)
    expect(mockSuppliers().flight.capabilities.maxAgeSeconds).toBe(DEFAULT_MAX_AGE_SECONDS)
  })
})
