import { money } from '../money.js'
import { nightsBetween } from './dates.js'
import { DEFAULT_MAX_AGE_SECONDS } from './types.js'
import type {
  FlightDetail, FlightSearch, HotelDetail, HotelSearch, LegSummary, QuoteOutcome,
  SearchParams, Supplier, SupplierCapabilities, SupplierItem, SupplierKind, SupplierPair,
} from './types.js'

export type MockConfig = {
  kind: SupplierKind
  /** How many items a search returns. Three, because that is what lesson 1.4 returned. */
  count?: number
  /** Changes every price and every id. Kept so one test can hold two different worlds. */
  seed?: number
  mayRequote?: boolean
  live?: boolean
  maxAgeSeconds?: number
  /**
   * Answer in this currency instead of the one the search asked for. Only a
   * deliberately dishonest supplier does this, and that is the point: lesson
   * 4.5's currency gate needs a mixed set, and inventing one by hand would test
   * the gate against data no supplier could produce.
   */
  currency?: string
  /** Added to every quoted price, so lesson 4.6's downgrade test has something to detect. */
  quoteDriftMinor?: bigint
  quoteMode?: 'ok' | 'throw' | 'unavailable' | 'gone'
  /** Injectable so a freshness test can age an item without sleeping. */
  now?: () => Date
}

/** FNV-1a over a string: the same query always lands on the same offers. */
function hash(input: string): number {
  let h = 0x811c9dc5
  for (const char of input) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const CARRIERS = ['TAP', 'Ryanair', 'easyJet'] as const
const CARRIER_CODES: Record<string, string> = { TAP: 'TP', Ryanair: 'FR', easyJet: 'U2' }
const HOTEL_NAMES = ['Praia Guesthouse', 'Hotel Atlantico', 'Quinta da Ria'] as const
/** One stopover per extra hop, so `route` and `flightNumbers` have real segments to hold. */
const STOPOVERS = ['MAD', 'BCN'] as const

/**
 * A stand-in for Kiwi and Google Hotels that never calls the network, so tests
 * and recordings see the same fares every time. Deterministic by construction:
 * prices and ids are derived from a hash of the search, so a replay gets
 * byte-identical results with no recorded fixture. Randomness here would make
 * every eval flaky and every failure unreproducible.
 *
 * One instance per kind. `search` and `quote` build a `detail` shaped for
 * `this.kind` but branch on `params.kind`, so a mismatch would otherwise
 * produce an item whose `kind` and `detail` disagree, which is an object no
 * gate downstream could interpret. It refuses instead of guessing which of the
 * two is right.
 *
 * The prices are lesson 1.4's, expression for expression, and they have to
 * stay that way: `test/fixtures/model/loop-portugal.json` is a recorded reply
 * quoting them, `test/provenance-v0.test.ts` compares that reply against these
 * numbers, and the replay client returns the recorded reply whatever the
 * request. `test/supplier-mock.test.ts` pins the six amounts that fixture
 * depends on.
 */
export class MockSupplier implements Supplier {
  readonly name = 'mock'
  readonly kind: SupplierKind
  readonly capabilities: SupplierCapabilities
  private readonly cfg: Required<Pick<MockConfig, 'count' | 'seed' | 'quoteMode' | 'now'>> & MockConfig
  private readonly lastResults = new Map<string, SupplierItem>()

  constructor(cfg: MockConfig) {
    this.kind = cfg.kind
    this.cfg = { count: 3, seed: 1, quoteMode: 'ok', now: () => new Date(), ...cfg }
    this.capabilities = {
      live: cfg.live ?? true,
      mayRequote: cfg.mayRequote ?? true,
      maxAgeSeconds: cfg.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
      // 'session' rather than 'indefinite' even though nothing expires here: a
      // mock that claimed a stronger persistence than any real supplier has
      // would let module 5.2's trimForContext behave one way in an eval and
      // another way in production.
      pricePersistence: 'session',
    }
  }

  async search(params: SearchParams): Promise<SupplierItem[]> {
    this.assertKind(params)
    const out: SupplierItem[] = []
    for (let i = 0; i < this.cfg.count; i += 1) {
      const item = params.kind === 'flight' ? this.flight(params, i) : this.hotel(params, i)
      this.lastResults.set(item.sourceId, item)
      out.push(item)
    }
    return out
  }

  async quote(sourceId: string, params: SearchParams): Promise<QuoteOutcome> {
    this.assertKind(params)
    if (this.cfg.quoteMode === 'throw') throw new Error('mock supplier: quote failed')
    if (this.cfg.quoteMode === 'unavailable') {
      return { status: 'unavailable', reason: 'mock: configured unavailable' }
    }
    if (this.cfg.quoteMode === 'gone') return { status: 'gone' }
    // Rebuild from params when this instance has not searched yet, exactly as a
    // real re-quote does: re-run the stored search, find by native id. A
    // resumed turn's cashier runs in a fresh process with an empty map, and a
    // supplier that called every price gone there would block every hand-off
    // that ever crossed an invocation.
    if (this.lastResults.size === 0) await this.search(params)
    const found = this.lastResults.get(sourceId)
    if (!found) return { status: 'gone' }
    const drift = this.cfg.quoteDriftMinor ?? 0n
    return {
      status: 'ok',
      item: drift === 0n
        ? found
        : { ...found, price: money(found.price.minor + drift, found.price.currency) },
    }
  }

  private assertKind(params: SearchParams): void {
    if (params.kind !== this.kind) {
      throw new RangeError(
        `MockSupplier configured for '${this.kind}' but received a '${params.kind}' search`,
      )
    }
  }

  private currencyFor(params: SearchParams): string {
    return this.cfg.currency ?? params.currency
  }

  private flight(params: FlightSearch, i: number): SupplierItem {
    // The hash input is lesson 1.4's, string for string: change it and every
    // price moves. `seed` stays first so a second seeded world is a different
    // world rather than a shifted one.
    const base = hash(`${this.cfg.seed}:${params.from}:${params.to}:${params.departureDate}`)
    const carrier = CARRIERS[i % CARRIERS.length]!
    const amount = 140 + ((base >>> (i * 5)) % 260)
    const sourceId = `flight-${carrier.toLowerCase()}-${(base % 9000) + i}`
    const stops = i % 3
    // Departures at 06:00, 10:30, 14:00, 18:30 and around again, so `count`
    // above four still produces a legal naive timestamp rather than hour 26.
    const depHour = 6 + ((i * 4) % 16)
    const minute = i % 2 === 1 ? '30' : '00'
    const outbound = this.leg(params.from, params.to, params.departureDate, depHour, minute, stops, carrier, 100 + i * 10)
    return {
      sourceId,
      supplier: this.name,
      kind: 'flight',
      name: `${carrier} ${params.from} to ${params.to}`,
      price: money(amount * 100, this.currencyFor(params)),
      priceBasis: 'total',
      fetchedAt: this.cfg.now(),
      ttlSeconds: this.capabilities.maxAgeSeconds,
      bookingUrl: `https://example.invalid/${sourceId}`,
      detail: {
        kind: 'flight',
        outbound,
        inbound: params.returnDate
          ? this.leg(params.to, params.from, params.returnDate, depHour, minute, stops, carrier, 300 + i * 10)
          : null,
        baggage: { personalItem: params.adults + params.children, cabinBag: i % 2, checkedBag: i % 3 },
        totalDurationSeconds: 12_600 + i * 600,
        selfTransfer: params.allowSelfTransfer && i % 2 === 1,
      } satisfies FlightDetail,
    }
  }

  private leg(
    from: string, to: string, date: string, depHour: number, minute: string,
    stops: number, carrier: string, numberBase: number,
  ): LegSummary {
    const route = [from, ...STOPOVERS.slice(0, stops), to]
    const pad = (h: number) => String(h).padStart(2, '0')
    return {
      from, to,
      // Naive local ISO with NO offset, exactly like Kiwi's (lesson 4.2). A
      // Date here would apply the server's zone and roll a late departure into
      // the next day, which is the bug lesson 4.5's dates gate is written
      // against.
      departureLocal: `${date}T${pad(depHour)}:${minute}:00`,
      arrivalLocal: `${date}T${pad(depHour + 3)}:${minute}:00`,
      stops,
      route,
      cabinClass: 'Economy',
      // A set, because "who flies this" is a set. `flightNumbers` below is per
      // segment and must not be deduplicated for the same reason.
      carriers: [CARRIER_CODES[carrier] ?? carrier],
      flightNumbers: route.slice(1).map((_, segment) => `${CARRIER_CODES[carrier] ?? 'ZZ'}${numberBase + segment}`),
    }
  }

  private hotel(params: HotelSearch, i: number): SupplierItem {
    const base = hash(`${this.cfg.seed}:${params.query}:${params.checkIn}:${params.checkOut}`)
    const perNight = 55 + ((base >>> (i * 6)) % 90)
    // Clamped to at least one night, as lesson 1.4's mock clamped it. A
    // zero-night stay would price at zero and then be the cheapest option in
    // every budget and ranking comparison: the most attractive possible answer
    // and an entirely fictional one.
    const nights = Math.max(1, nightsBetween(params.checkIn, params.checkOut))
    const sourceId = `hotel-${i}-${base % 9000}`
    return {
      sourceId,
      supplier: this.name,
      kind: 'hotel',
      name: `${HOTEL_NAMES[i % HOTEL_NAMES.length]}, ${params.query}`,
      price: money(perNight * nights * 100, this.currencyFor(params)),
      priceBasis: 'total',
      fetchedAt: this.cfg.now(),
      ttlSeconds: this.capabilities.maxAgeSeconds,
      bookingUrl: `https://example.invalid/${sourceId}`,
      detail: {
        kind: 'hotel',
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        nights,
        rating: 3 + (i % 3) * 0.5,
        coordinates: { lat: 37.02, lon: -7.93 },
        offerSource: 'mock.example',
      } satisfies HotelDetail,
    }
  }
}

/**
 * The pair a tool runner needs: one mock per kind, configurable per kind. Every
 * call site that used to construct a supplier by hand now builds a pair here,
 * or says nothing at all and lets `mockRunner`'s default build one.
 */
export function mockSuppliers(
  over: { flight?: Omit<MockConfig, 'kind'>; hotel?: Omit<MockConfig, 'kind'> } = {},
): SupplierPair {
  return {
    flight: new MockSupplier({ ...over.flight, kind: 'flight' }),
    hotel: new MockSupplier({ ...over.hotel, kind: 'hotel' }),
  }
}
