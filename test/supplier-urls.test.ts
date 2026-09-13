import { describe, expect, it } from 'vitest'
import { withTracking, isRegistrableHost, isKiwiHost, BookingUrlError, TRACKING_PARAM } from '../src/supplier/urls.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { KiwiSupplier } from '../src/supplier/kiwi.js'
import { SearchApiHotels } from '../src/supplier/searchapi.js'
import { money } from '../src/money.js'
import type { SupplierItem } from '../src/supplier/types.js'

const item = (over: Partial<SupplierItem>): SupplierItem => ({
  sourceId: 'X', supplier: 'kiwi', kind: 'flight', name: 'n', price: money(1n, 'EUR'), priceBasis: 'total',
  fetchedAt: new Date(), ttlSeconds: 900, bookingUrl: null,
  detail: { kind: 'flight', outbound: { from: 'A', to: 'B', departureLocal: 'x', arrivalLocal: 'y', stops: 0, route: [], cabinClass: 'E', carriers: [], flightNumbers: [] }, inbound: null, baggage: { personalItem: 0, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 0, selfTransfer: false },
  ...over,
})

describe('withTracking', () => {
  it('appends the tracking ref as a query parameter and keeps the rest of the URL', () => {
    const out = withTracking('https://kiwi.com/u/abc?x=1', 'trk_1', isKiwiHost)
    const u = new URL(out)
    expect(u.hostname).toBe('kiwi.com'); expect(u.searchParams.get('x')).toBe('1')
    expect(u.searchParams.get(TRACKING_PARAM)).toBe('trk_1')
  })
  it('replaces an existing tracking parameter rather than doubling it', () => {
    const u = new URL(withTracking(`https://kiwi.com/u/abc?${TRACKING_PARAM}=old`, 'new', isKiwiHost))
    expect(u.searchParams.getAll(TRACKING_PARAM)).toEqual(['new'])
  })
  it.each(['http://kiwi.com/u/abc', 'https://user:pw@kiwi.com/u', 'https://evil.com/kiwi.com', 'https://kiwi.com.evil.com/u', 'javascript:alert(1)', 'not a url'])
    ('refuses %s', (raw) => { expect(() => withTracking(raw, 't', isKiwiHost)).toThrow(BookingUrlError) })
  it('accepts a kiwi subdomain', () => { expect(() => withTracking('https://www.kiwi.com/u/abc', 't', isKiwiHost)).not.toThrow() })
})

describe('isRegistrableHost', () => {
  it.each(['booking.com', 'www.pureformosa.com', 'domo-camp.org'])('accepts %s', (h) => expect(isRegistrableHost(h)).toBe(true))
  it.each(['localhost', '127.0.0.1', '[::1]', 'intranet', '10.0.0.1', ''])('refuses %s', (h) => expect(isRegistrableHost(h)).toBe(false))
})

describe('suppliers', () => {
  it('mock builds a URL on its own host carrying the ref', () => {
    const u = new URL(new MockSupplier({ kind: 'flight' }).bookingUrl(item({ supplier: 'mock' }), 'trk'))
    expect(u.hostname).toBe('mock.example'); expect(u.searchParams.get(TRACKING_PARAM)).toBe('trk')
  })
  it('kiwi uses the item\'s own deep link and refuses one off its domain', () => {
    const k = new KiwiSupplier()
    expect(new URL(k.bookingUrl(item({ bookingUrl: 'https://kiwi.com/u/4ym6t4q' }), 'trk')).searchParams.get(TRACKING_PARAM)).toBe('trk')
    expect(() => k.bookingUrl(item({ bookingUrl: 'https://example.com/u/1' }), 'trk')).toThrow(BookingUrlError)
    expect(() => k.bookingUrl(item({ bookingUrl: null }), 'trk')).toThrow(BookingUrlError)
  })
  it('searchapi accepts any https registrable host, since the link is the property\'s own site', () => {
    const s = new SearchApiHotels('key')   // match the constructor the file already has
    const u = new URL(s.bookingUrl(item({ supplier: 'searchapi', kind: 'hotel', bookingUrl: 'https://www.booking.com/hotel/pt/x.html?aid=1' }), 'trk'))
    expect(u.hostname).toBe('www.booking.com'); expect(u.searchParams.get('aid')).toBe('1'); expect(u.searchParams.get(TRACKING_PARAM)).toBe('trk')
    expect(() => s.bookingUrl(item({ supplier: 'searchapi', bookingUrl: 'http://www.adaavo.pt/' }), 'trk')).toThrow(BookingUrlError)
    expect(() => s.bookingUrl(item({ supplier: 'searchapi', bookingUrl: 'https://localhost/x' }), 'trk')).toThrow(BookingUrlError)
  })
})
