import { checkCurrency, checkFreshness } from '../src/gates/checks.js'
import { money } from '../src/money.js'
import type { RehydratedItem } from '../src/gates/types.js'
import type { SupplierItem } from '../src/supplier/types.js'

const NOW = new Date('2026-08-16T12:00:00Z')

function item(over: Partial<SupplierItem> = {}, quantity = 1): RehydratedItem {
  const it: SupplierItem = {
    sourceId: over.sourceId ?? 'S1', supplier: 'mock', kind: 'hotel', name: 'H',
    price: over.price ?? money(10_000n, 'EUR'), priceBasis: 'total',
    fetchedAt: over.fetchedAt ?? new Date('2026-08-16T11:55:00Z'),
    ttlSeconds: over.ttlSeconds ?? 900, bookingUrl: null,
    detail: { kind: 'hotel', checkIn: '2026-09-12', checkOut: '2026-09-19',
              nights: 7, rating: null, coordinates: null, offerSource: null },
    ...over,
  }
  return { ref: { sourceId: it.sourceId, quantity, slot: 'stay' }, item: it,
           lineTotal: money(it.price.minor * BigInt(quantity), it.price.currency) }
}

describe('checkFreshness', () => {
  it('passes an item inside its TTL', () => {
    expect(checkFreshness([item()], NOW)).toEqual([])
  })

  it('fails an item past its TTL and names it', () => {
    const stale = item({ sourceId: 'OLD', fetchedAt: new Date('2026-08-16T11:00:00Z'), ttlSeconds: 900 })
    const v = checkFreshness([stale], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('freshness')
    expect(v[0]!.sourceIds).toEqual(['OLD'])
    expect(v[0]!.detail).toMatch(/re-?search/i)
  })

  it('is exact at the boundary: a ttl elapsed exactly is still fresh', () => {
    expect(checkFreshness([item({ fetchedAt: new Date(NOW.getTime() - 900_000), ttlSeconds: 900 })], NOW)).toEqual([])
    expect(checkFreshness([item({ fetchedAt: new Date(NOW.getTime() - 900_001), ttlSeconds: 900 })], NOW)).toHaveLength(1)
  })

  it('uses each item\'s own TTL, not a shared constant', () => {
    // Kiwi says 900 and SearchApi says 3600 (lesson 4.2), so this is a real
    // difference and not a hypothetical one.
    const shortTtl = item({ sourceId: 'SHORT', fetchedAt: new Date(NOW.getTime() - 400_000), ttlSeconds: 300 })
    const longTtl = item({ sourceId: 'LONG', fetchedAt: new Date(NOW.getTime() - 400_000), ttlSeconds: 3600 })
    const v = checkFreshness([shortTtl, longTtl], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['SHORT'])
  })

  it('groups every stale item into one violation', () => {
    const a = item({ sourceId: 'A', fetchedAt: new Date('2026-08-16T10:00:00Z') })
    const b = item({ sourceId: 'B', fetchedAt: new Date('2026-08-16T10:00:00Z') })
    const v = checkFreshness([a, b], NOW)
    expect(v).toHaveLength(1)
    expect([...v[0]!.sourceIds].sort()).toEqual(['A', 'B'])
  })

  it('rejects an item stamped in the future rather than treating it as fresh', () => {
    // Not pedantry: a future fetched_at means a clock disagreement somewhere,
    // and the one thing not to do with a timestamp we cannot trust is treat it
    // as reassuring.
    const v = checkFreshness([item({ sourceId: 'FUTURE', fetchedAt: new Date(NOW.getTime() + 60_000) })], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['FUTURE'])
  })

  it('treats an unparseable fetchedAt as stale rather than silently fresh', () => {
    // NaN fails both `< 0` and `> ttl`, so an ordinary bounds check classifies
    // a corrupt timestamp as fresh. It has to be handled explicitly.
    const v = checkFreshness([item({ sourceId: 'CORRUPT', fetchedAt: new Date('not-a-date') })], NOW)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['CORRUPT'])
  })

  it('passes an empty set', () => {
    expect(checkFreshness([], NOW)).toEqual([])
  })
})

describe('checkCurrency, with a trip currency given', () => {
  it('passes when every item matches the expected currency', () => {
    expect(checkCurrency([item(), item({ sourceId: 'S2' })], 'EUR')).toEqual([])
  })

  it('fails an item in a different currency and never converts', () => {
    const gbp = item({ sourceId: 'GBP1', price: money(9_000n, 'GBP') })
    const v = checkCurrency([item(), gbp], 'EUR')
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('currency')
    expect(v[0]!.sourceIds).toEqual(['GBP1'])
    expect(v[0]!.detail).not.toMatch(/convert|exchange|rate/i)
  })

  // Discriminates from an implementation that only checks items against EACH
  // OTHER and never against `expected`: every item here shares one currency, so
  // a self-consistency-only check returns [] and passes. The real behaviour
  // flags all three, because none of them is in the trip currency.
  it('fails every item when they all agree with each other but not with expected', () => {
    const v = checkCurrency([
      item({ sourceId: 'A', price: money(1_000n, 'GBP') }),
      item({ sourceId: 'B', price: money(2_000n, 'GBP') }),
      item({ sourceId: 'C', price: money(3_000n, 'GBP') }),
    ], 'EUR')
    expect(v).toHaveLength(1)
    expect([...v[0]!.sourceIds].sort()).toEqual(['A', 'B', 'C'])
  })

  it('names every offender in a three-way mix, even when none is the expected currency', () => {
    const v = checkCurrency([
      item({ sourceId: 'A', price: money(1n, 'GBP') }),
      item({ sourceId: 'B', price: money(1n, 'USD') }),
      item({ sourceId: 'C', price: money(1n, 'CHF') }),
    ], 'EUR')
    expect(v).toHaveLength(1)
    expect([...v[0]!.sourceIds].sort()).toEqual(['A', 'B', 'C'])
  })

  it('matches expected case-insensitively, the same way money() normalises', () => {
    expect(checkCurrency([item()], 'eur')).toEqual([])
  })

  it('passes an empty set', () => {
    expect(checkCurrency([], 'EUR')).toEqual([])
  })
})

describe('checkCurrency, with no trip currency set yet', () => {
  it('passes when all items already agree, even though no expected currency exists', () => {
    expect(checkCurrency([
      item({ sourceId: 'A', price: money(1_000n, 'GBP') }),
      item({ sourceId: 'B', price: money(2_000n, 'GBP') }),
    ], null)).toEqual([])
  })

  it('fails a mixed set with every distinct currency and every offending id named', () => {
    const v = checkCurrency([
      item({ sourceId: 'A', price: money(1n, 'GBP') }),
      item({ sourceId: 'B', price: money(1n, 'USD') }),
    ], null)
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('currency')
    expect([...v[0]!.sourceIds].sort()).toEqual(['A', 'B'])
    expect(v[0]!.detail).toMatch(/GBP/)
    expect(v[0]!.detail).toMatch(/USD/)
    expect(v[0]!.detail).not.toMatch(/convert|exchange|rate/i)
  })

  it('passes an empty set', () => {
    expect(checkCurrency([], null)).toEqual([])
  })
})
