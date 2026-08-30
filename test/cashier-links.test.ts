import { BOOKING_HOSTS, bookingUrl, handOffMessage, UnknownSupplierError } from '../src/cashier.js'
import { money } from '../src/money.js'
import type { EmittedLink } from '../src/repo/linkClicks.js'

const REF = '3f1c2b90-0000-4000-8000-000000000001'

describe('bookingUrl', () => {
  it('builds a URL on the supplier\'s own allowlisted host', () => {
    for (const supplier of Object.keys(BOOKING_HOSTS)) {
      const url = new URL(bookingUrl(supplier, 'ITEM-1', REF))
      expect(url.protocol).toBe('https:')
      expect(url.hostname).toBe(BOOKING_HOSTS[supplier])
    }
  })

  it('carries the tracking ref, so a click can be attributed', () => {
    for (const supplier of Object.keys(BOOKING_HOSTS)) {
      expect(bookingUrl(supplier, 'ITEM-1', REF)).toContain(REF)
    }
  })

  /**
   * The exfiltration case, and the reason the host is re-parsed off the built
   * string rather than trusted from the template. `sourceId` is
   * supplier-supplied text that travelled through the corpus, so a template
   * that interpolated it raw would let a value like
   * `x@evil.example/`, or one carrying a `?` or a `#`, move the host or replace
   * every query parameter after it. Encoding is the fix and re-parsing is the
   * proof.
   */
  it('cannot be moved to another host by a hostile source id', () => {
    const hostile = [
      'evil.example/@',
      'x@evil.example',
      '../../evil',
      'a?redirect=https://evil.example',
      'a#@evil.example',
      'a&affilid=someone-else',
    ]
    for (const supplier of Object.keys(BOOKING_HOSTS)) {
      for (const id of hostile) {
        const url = new URL(bookingUrl(supplier, id, REF))
        expect(url.hostname).toBe(BOOKING_HOSTS[supplier])
        expect(url.protocol).toBe('https:')
        // And the ref is still ours, not one the id smuggled in.
        expect(url.href).toContain(REF)
      }
    }
  })

  it('refuses a supplier it has no template for, rather than guessing one', () => {
    // The model never chooses this string: it comes off a corpus row, written by
    // one of our own adapters. Refusing anyway is what stops a new adapter
    // shipping without anybody deciding where its links point.
    expect(() => bookingUrl('expedia', 'ITEM-1', REF)).toThrow(UnknownSupplierError)
  })

  it('refuses a prototype key as a supplier name rather than resolving it', () => {
    // Same trap checkSlots has (src/gates/checks.ts): a bare index returns a
    // function for 'toString' and an object for '__proto__', both truthy.
    for (const key of ['__proto__', 'toString', 'constructor', 'valueOf']) {
      expect(() => bookingUrl(key, 'ITEM-1', REF)).toThrow(UnknownSupplierError)
    }
  })

  it('covers every supplier this branch can put in the corpus', () => {
    // mock, kiwi and searchapi are the three `SupplierItem.supplier` values
    // anything on this branch writes. A fourth adapter without a template would
    // make a hand-off throw at the worst possible moment.
    expect(Object.keys(BOOKING_HOSTS).sort()).toEqual(['kiwi', 'mock', 'searchapi'])
  })
})

describe('handOffMessage', () => {
  const link = (over: Partial<EmittedLink> = {}): EmittedLink => ({
    id: REF, sourceId: 'ITEM-1', supplier: 'kiwi',
    url: 'https://www.kiwi.com/deep?x=1', trackingRef: REF,
    quoted: money(46_400n, 'EUR'), ...over,
  })
  const quotedAt = new Date('2026-08-16T10:00:00Z')
  const now = new Date('2026-08-16T12:00:00Z')

  it('says the price was checked when it was', () => {
    const text = handOffMessage([link()], true, quotedAt, now)
    expect(text).toContain('€464.00')
    expect(text).toMatch(/checked/i)
    // No age, because there is nothing to disclose: the number is current.
    expect(text).not.toMatch(/2 hours ago/)
  })

  it('discloses the age instead of claiming verification when it could not check', () => {
    const text = handOffMessage([link()], false, quotedAt, now)
    // Rule 4: do not claim verification. The copy becomes disclosure, and every
    // price renders with its age.
    expect(text).not.toMatch(/checked|verified|confirmed/i)
    expect(text).toContain('€464.00')
    expect(text).toContain('2 hours ago')
    expect(text).toMatch(/check the total before you pay/i)
  })

  it('totals a multi-item hand-off in one currency', () => {
    const text = handOffMessage([link(), link({ sourceId: 'ITEM-2', quoted: money(53_600n, 'EUR') })], true, quotedAt, now)
    expect(text).toContain('€1,000.00')
  })

  it('describes an age in days once it is past a day', () => {
    const text = handOffMessage([link()], false, new Date('2026-08-14T12:00:00Z'), now)
    expect(text).toContain('2 days ago')
  })
})
