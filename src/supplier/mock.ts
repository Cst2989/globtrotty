import { money } from '../money.js'
import { nightsBetween } from './dates.js'
import { DEFAULT_MAX_AGE_SECONDS } from './types.js'
import type {
  Supplier, SupplierItem, SupplierKind, SearchParams, QuoteOutcome, SupplierCapabilities,
} from './types.js'
import { withTracking } from './urls.js'

export type MockConfig = {
  kind: SupplierKind
  count?: number
  mayRequote?: boolean
  live?: boolean
  maxAgeSeconds?: number
  /** Added to every quoted price, so a cashier downgrade test has something to detect. */
  quoteDriftMinor?: bigint
  quoteMode?: 'ok' | 'throw' | 'unavailable' | 'gone'
  /** Injectable so a freshness test can age an item without sleeping. */
  now?: () => Date
}

/**
 * Deterministic by construction: prices and ids are derived from a hash of the
 * search params, so a replay in slice 2 gets byte-identical results without a
 * recorded fixture. Randomness here would make every eval flaky and every
 * failure unreproducible.
 */
export class MockSupplier implements Supplier {
  readonly name = 'mock'
  readonly kind: SupplierKind
  readonly capabilities: SupplierCapabilities
  private readonly cfg: Required<Pick<MockConfig, 'count' | 'quoteMode' | 'now'>> & MockConfig
  private lastResults = new Map<string, SupplierItem>()

  constructor(cfg: MockConfig) {
    this.kind = cfg.kind
    this.cfg = { count: 5, quoteMode: 'ok', now: () => new Date(), ...cfg }
    this.capabilities = {
      live: cfg.live ?? true,
      mayRequote: cfg.mayRequote ?? true,
      maxAgeSeconds: cfg.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
      pricePersistence: 'session',
    }
  }

  async search(params: SearchParams): Promise<SupplierItem[]> {
    this.assertKind(params)
    const seed = hash(JSON.stringify(params))
    const out: SupplierItem[] = []
    for (let i = 0; i < this.cfg.count; i++) {
      const item = this.build(params, seed, i)
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
    // Rebuild from params so a quote works on a fresh instance, exactly as a
    // real re-quote does (re-run the stored search, find by native id).
    if (this.lastResults.size === 0) await this.search(params)
    const found = this.lastResults.get(sourceId)
    if (!found) return { status: 'gone' }
    const drift = this.cfg.quoteDriftMinor ?? 0n
    return {
      status: 'ok',
      item: drift === 0n ? found
        : { ...found, price: money(found.price.minor + drift, found.price.currency) },
    }
  }

  /**
   * `search`/`quote` build a `detail` shaped for `this.kind` but branch on
   * `params.kind`; a mismatch would otherwise silently produce an item whose
   * `kind` and `detail` disagree — an object no gate downstream could
   * interpret. Refuse instead of guessing which one is right.
   */
  bookingUrl(item: SupplierItem, trackingRef: string): string {
    return withTracking(
      `https://mock.example/book/${encodeURIComponent(item.sourceId)}`,
      trackingRef,
      (h) => h === 'mock.example',
    )
  }

  private assertKind(params: SearchParams): void {
    if (params.kind !== this.kind) {
      throw new RangeError(
        `MockSupplier configured for '${this.kind}' but received a '${params.kind}' search`,
      )
    }
  }

  private build(params: SearchParams, seed: number, i: number): SupplierItem {
    const sourceId = `MOCK-${this.kind}-${seed.toString(16)}-${i}`
    const minor = BigInt(20_000 + ((seed + i * 7919) % 60_000))
    const base = {
      sourceId, supplier: this.name, kind: this.kind, name: `${this.kind} option ${i + 1}`,
      price: money(minor, params.currency),
      priceBasis: 'total' as const,
      fetchedAt: this.cfg.now(),
      ttlSeconds: this.capabilities.maxAgeSeconds,
      bookingUrl: `https://mock.example/book/${sourceId}`,
    }
    if (params.kind === 'flight') {
      return {
        ...base,
        detail: {
          kind: 'flight',
          outbound: {
            from: params.from, to: params.to,
            departureLocal: `${params.departureDate}T08:00:00`,
            arrivalLocal: `${params.departureDate}T11:30:00`,
            stops: i % 2, route: [params.from, params.to],
            cabinClass: params.cabinClass, carriers: ['ZZ'],
            // Derived from `i`, like every other field here, so a replay in
            // slice 2 gets the same identity back. Two entries when the leg has
            // a stop, one when it does not: the list is per SEGMENT, and
            // `stops: i % 2` is what decides how many segments there are.
            flightNumbers: i % 2 === 1 ? [`ZZ${100 + i}`, `ZZ${200 + i}`] : [`ZZ${100 + i}`],
          },
          inbound: params.returnDate ? {
            from: params.to, to: params.from,
            departureLocal: `${params.returnDate}T18:00:00`,
            arrivalLocal: `${params.returnDate}T21:30:00`,
            stops: i % 2, route: [params.to, params.from],
            cabinClass: params.cabinClass, carriers: ['ZZ'],
            flightNumbers: i % 2 === 1 ? [`ZZ${300 + i}`, `ZZ${400 + i}`] : [`ZZ${300 + i}`],
          } : null,
          baggage: { personalItem: params.adults, cabinBag: i % 2, checkedBag: i % 3 },
          totalDurationSeconds: 12_600 + i * 600,
          selfTransfer: params.allowSelfTransfer && i % 2 === 1,
        },
      }
    }
    return {
      ...base,
      detail: {
        kind: 'hotel',
        checkIn: params.checkIn, checkOut: params.checkOut,
        nights: nightsBetween(params.checkIn, params.checkOut),
        rating: 3 + (i % 3) * 0.5,
        coordinates: { lat: 37.02, lon: -7.93 },
        offerSource: 'mock.example',
      },
    }
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
