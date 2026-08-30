import { MockSupplier, mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const search: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO',
  departureDate: '2026-09-19', returnDate: '2026-09-26', flexDays: 0,
  adults: 2, children: 1, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const stay: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

describe('MockSupplier', () => {
  it('is deterministic: the same params yield the same ids and prices', async () => {
    const a = await new MockSupplier({ kind: 'flight' }).search(search)
    const b = await new MockSupplier({ kind: 'flight' }).search(search)
    expect(a.map((i) => i.sourceId)).toEqual(b.map((i) => i.sourceId))
    expect(a.map((i) => i.price.minor)).toEqual(b.map((i) => i.price.minor))
    expect(a).toHaveLength(3)
  })

  it('varies with the params, so two searches are not silently identical', async () => {
    const a = await new MockSupplier({ kind: 'flight' }).search(search)
    const b = await new MockSupplier({ kind: 'flight' }).search({ ...search, to: 'LIS' })
    expect(a[0]!.sourceId).not.toBe(b[0]!.sourceId)
    expect(a.map((i) => i.price.minor)).not.toEqual(b.map((i) => i.price.minor))
  })

  /**
   * The load-bearing one. `test/fixtures/model/loop-portugal.json` holds a
   * recorded reply quoting twelve amounts, and `test/provenance-v0.test.ts`
   * asserts every amount in that reply appears in a tool result of the same
   * run. The replay client returns the recorded reply whatever the request, so
   * a change to these numbers changes only one side of that comparison, and
   * there is no key in CI to re-record the other.
   *
   * All twelve are pinned, across all four searches that fixture drove
   * (BER-FAO and BER-LIS flights, Faro and Lisbon hotels), so that a derivation
   * change which happened to move only one pair of searches still fails here.
   * They are the exact minor units lesson 1.4's mock produced, pinned in the
   * supplier's own test so that a change to the price derivation fails with a
   * message about the price derivation rather than as a mysterious provenance
   * failure three files away.
   */
  it('still prices all four recorded fixture searches exactly as lesson 1.4 did', async () => {
    const flightsTo = async (to: string) =>
      (await new MockSupplier({ kind: 'flight' }).search({ ...search, to })).map((i) => i.price.minor)
    const hotelsIn = async (query: string) =>
      (await new MockSupplier({ kind: 'hotel' }).search({ ...stay, query })).map((i) => i.price.minor)

    expect(await flightsTo('FAO')).toEqual([38800n, 14700n, 27800n])
    expect(await flightsTo('LIS')).toEqual([23000n, 27200n, 35500n])
    expect(await hotelsIn('Faro')).toEqual([72100n, 84000n, 69300n])
    expect(await hotelsIn('Lisbon')).toEqual([56000n, 95200n, 65800n])
  })

  it('prices in the requested currency', async () => {
    const items = await new MockSupplier({ kind: 'flight' }).search({ ...search, currency: 'GBP' })
    expect(items.every((i) => i.price.currency === 'GBP')).toBe(true)
  })

  /**
   * Three implementations of one port, and this is the one the whole suite runs
   * on. `src/supplier/kiwi.ts` and `src/supplier/searchapi.ts` both scale their
   * float price by `10 ** minorUnitExponent(params.currency)`; this one scaled
   * by a hard-coded hundred until the whole-branch review, which was invisible
   * only because every currency the suite searched in (EUR, GBP, USD) has
   * exponent 2.
   *
   * From lesson 4.5 the search currency follows her budget, so the currency in
   * these params is hers, and `src/money.ts` holds JPY at exponent 0 and KWD at
   * 3. A hundred everywhere prices a JPY hotel at a hundred times her budget,
   * which the budget gate rejects forever, and a KWD trip at a tenth of it,
   * which the budget gate PASSES and `handOffMessage` then shows her against a
   * real booking link.
   *
   * The three amounts are the SAME three every EUR case in this file pins,
   * because the hash input carries no currency: only the scale moves, which is
   * exactly the property that keeps lesson 1.4's twelve recorded prices intact.
   */
  it('scales prices by the currency exponent rather than by a hard-coded hundred', async () => {
    const flightsIn = async (currency: string) =>
      (await new MockSupplier({ kind: 'flight' }).search({ ...search, currency }))
        .map((i) => i.price.minor)
    const hotelsIn = async (currency: string) =>
      (await new MockSupplier({ kind: 'hotel' }).search({ ...stay, currency }))
        .map((i) => i.price.minor)

    expect(await flightsIn('EUR')).toEqual([38800n, 14700n, 27800n])   // exponent 2, unmoved
    expect(await flightsIn('JPY')).toEqual([388n, 147n, 278n])         // exponent 0
    expect(await flightsIn('KWD')).toEqual([388000n, 147000n, 278000n]) // exponent 3
    expect(await hotelsIn('EUR')).toEqual([72100n, 84000n, 69300n])
    expect(await hotelsIn('JPY')).toEqual([721n, 840n, 693n])
  })

  /**
   * The deliberately dishonest supplier, and the only reason it exists: lesson
   * 4.5's currency gate needs a set of items that mix currencies, and the only
   * honest way to produce one from a mock that otherwise answers in the
   * currency it was asked for is to configure one that does not.
   */
  it('can be configured to answer in a currency nobody asked for', async () => {
    const items = await new MockSupplier({ kind: 'hotel', currency: 'USD' }).search(stay)
    expect(stay.currency).toBe('EUR')
    expect(items.every((i) => i.price.currency === 'USD')).toBe(true)
  })

  it('quotes an existing id as ok with the same price', async () => {
    const s = new MockSupplier({ kind: 'flight' })
    const [first] = await s.search(search)
    const q = await s.quote(first!.sourceId, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') expect(q.item.price.minor).toBe(first!.price.minor)
  })

  it('quotes an id it has never searched by re-running the search first', async () => {
    // A fresh instance has no memory, exactly like a fresh process. A real
    // re-quote re-runs the stored search and finds by native id; this must do
    // the same, or a cashier in a resumed turn would call every price gone.
    const searched = await new MockSupplier({ kind: 'flight' }).search(search)
    const fresh = new MockSupplier({ kind: 'flight' })
    const q = await fresh.quote(searched[0]!.sourceId, search)
    expect(q.status).toBe('ok')
  })

  it('re-runs the search for an id it does not hold, even after serving another search', async () => {
    // The hand-off `quote`'s own comment describes, one search later than an
    // empty map. `loop-portugal.json` drives BER-FAO and BER-LIS through one
    // instance, so a resumed invocation can easily have searched LIS before the
    // cashier asks it to re-quote an FAO id against its stored FAO params. A
    // guard that fired only on an empty map would skip the re-search here and
    // report a live fare gone.
    const faoIds = (await new MockSupplier({ kind: 'flight' }).search(search)).map((i) => i.sourceId)
    const resumed = new MockSupplier({ kind: 'flight' })
    await resumed.search({ ...search, to: 'LIS' })
    const q = await resumed.quote(faoIds[0]!, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') expect(q.item.sourceId).toBe(faoIds[0])
  })

  it('quotes an unknown id as gone', async () => {
    const s = new MockSupplier({ kind: 'flight' })
    await s.search(search)
    expect((await s.quote('no-such-id', search)).status).toBe('gone')
  })

  it('can be configured to move a price between search and quote', async () => {
    const s = new MockSupplier({ kind: 'flight', quoteDriftMinor: 5000n })
    const [first] = await s.search(search)
    const q = await s.quote(first!.sourceId, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') expect(q.item.price.minor).toBe(first!.price.minor + 5000n)
  })

  it('can be configured to fail a quote, because unknown is not unchanged', async () => {
    const s = new MockSupplier({ kind: 'flight', quoteMode: 'throw' })
    const [first] = await s.search(search)
    await expect(s.quote(first!.sourceId, search)).rejects.toThrow(/quote failed/i)

    const u = new MockSupplier({ kind: 'flight', quoteMode: 'unavailable' })
    const [f2] = await u.search(search)
    expect((await u.quote(f2!.sourceId, search)).status).toBe('unavailable')

    const g = new MockSupplier({ kind: 'flight', quoteMode: 'gone' })
    const [f3] = await g.search(search)
    expect((await g.quote(f3!.sourceId, search)).status).toBe('gone')
  })

  it('can declare itself non-requotable', () => {
    expect(new MockSupplier({ kind: 'flight', mayRequote: false }).capabilities.mayRequote).toBe(false)
    expect(new MockSupplier({ kind: 'flight' }).capabilities.mayRequote).toBe(true)
  })

  it('stamps fetchedAt from the injected clock, not wall time', async () => {
    const at = new Date('2026-08-16T12:00:00Z')
    const items = await new MockSupplier({ kind: 'flight', now: () => at }).search(search)
    expect(items.every((i) => i.fetchedAt.getTime() === at.getTime())).toBe(true)
    expect(items.every((i) => i.ttlSeconds === 900)).toBe(true)
  })

  it('produces hotel items with nights derived from the date range', async () => {
    const items = await new MockSupplier({ kind: 'hotel' }).search(stay)
    const detail = items[0]!.detail
    expect(detail.kind).toBe('hotel')
    if (detail.kind !== 'hotel') throw new Error('unreachable')
    expect(detail.nights).toBe(7)
    expect(detail.checkIn).toBe('2026-09-19')
  })

  it('gives a flight one flight number per segment, in route order', async () => {
    const items = await new MockSupplier({ kind: 'flight' }).search(search)
    for (const item of items) {
      const detail = item.detail
      if (detail.kind !== 'flight') throw new Error('unreachable')
      // One number per hop, so lesson 4.6 can tell a two-segment itinerary from
      // a one-segment itinerary that happens to cost the same.
      expect(detail.outbound.flightNumbers).toHaveLength(detail.outbound.route.length - 1)
      // route is [from, ...stopovers, to], so a leg with n stops has n + 2
      // airports and n + 1 segments.
      expect(detail.outbound.stops).toBe(detail.outbound.route.length - 2)
      expect(detail.inbound).not.toBeNull()
    }
  })

  it('leaves inbound null for a one-way search', async () => {
    const items = await new MockSupplier({ kind: 'flight' }).search({ ...search, returnDate: null })
    const detail = items[0]!.detail
    if (detail.kind !== 'flight') throw new Error('unreachable')
    expect(detail.inbound).toBeNull()
  })

  it('rejects a search whose params.kind does not match the configured kind', async () => {
    await expect(new MockSupplier({ kind: 'hotel' }).search(search))
      .rejects.toThrow(/hotel.*flight|flight.*hotel/i)
  })

  it('rejects a quote whose params.kind does not match the configured kind', async () => {
    await expect(new MockSupplier({ kind: 'flight' }).quote('anything', stay))
      .rejects.toThrow(/hotel.*flight|flight.*hotel/i)
  })

  it('honours count, so a test can ask for more or fewer than the default three', async () => {
    expect(await new MockSupplier({ kind: 'flight', count: 1 }).search(search)).toHaveLength(1)
    expect(await new MockSupplier({ kind: 'flight', count: 5 }).search(search)).toHaveLength(5)
  })
})

describe('mockSuppliers', () => {
  it('builds one supplier per kind, each declaring its own kind', () => {
    const pair = mockSuppliers()
    expect(pair.flight.kind).toBe('flight')
    expect(pair.hotel.kind).toBe('hotel')
    expect(pair.flight.name).toBe('mock')
  })

  it('passes per-kind configuration through', async () => {
    const pair = mockSuppliers({ hotel: { currency: 'USD' }, flight: { mayRequote: false } })
    expect(pair.flight.capabilities.mayRequote).toBe(false)
    expect(pair.hotel.capabilities.mayRequote).toBe(true)
    const hotels = await pair.hotel.search(stay)
    expect(hotels.every((i) => i.price.currency === 'USD')).toBe(true)
  })

  it('does not price the same amounts as a real one would, and says so in its name', async () => {
    // `supplier` is what a corpus row records and what lesson 4.6 uses to pick
    // a URL template, so a mock item must be recognisable as one.
    const items = await mockSuppliers().flight.search(search)
    expect(items.every((i) => i.supplier === 'mock')).toBe(true)
    expect(items.every((i) => i.bookingUrl?.startsWith('https://example.invalid/'))).toBe(true)
  })
})
