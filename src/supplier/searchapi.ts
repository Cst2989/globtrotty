import { money, minorUnitExponent } from '../money.js'
import { nightsBetween } from './dates.js'
import {
  UnusableResponseError,
  type Supplier, type SupplierItem, type SupplierCapabilities, type SearchParams,
  type HotelSearch, type QuoteOutcome, type PriceBasis,
} from './types.js'

const ENDPOINT = 'https://www.searchapi.io/api/v1/search'

type Price = {
  extracted_price?: number | null
  extracted_price_before_taxes?: number | null
}
type Property = {
  property_token?: string; name?: string; link?: string
  gps_coordinates?: { latitude: number; longitude: number }
  rating?: number; total_price?: Price
  offers?: { source?: string }[]
}

export const SEARCHAPI_CAPABILITIES: SupplierCapabilities = {
  live: true,
  // property_token is stable across searches, so a re-quote is a re-search plus
  // a find, the same shape as Kiwi's.
  mayRequote: true,
  // An hour rather than Kiwi's fifteen minutes: a hotel rate moves far more
  // slowly than a fare. Not DEFAULT_MAX_AGE_SECONDS, because this is a
  // different number for a different reason and sharing the constant would
  // couple two decisions that are not the same decision.
  maxAgeSeconds: 3600,
  pricePersistence: 'session',
}

/**
 * Pure: raw JSON text in, normalised items out.
 *
 * Price selection is the load-bearing decision. We prefer the all-in
 * `total_price`, fall back to the pre-tax figure and LABEL it, and drop a
 * property that offers neither. Defaulting a missing price to zero would make
 * the unpriced hotel the cheapest option in every budget comparison: the most
 * attractive possible answer, and entirely fictional.
 */
export function parseSearchApiHotels(body: string, params: HotelSearch, now: Date): SupplierItem[] {
  const data = JSON.parse(body) as {
    search_parameters?: { currency?: string }
    properties?: Property[]
    error?: unknown
  }
  if (data.error) throw new Error(`searchapi: ${String(data.error)}`)

  // search_parameters.currency echoes the currency SearchApi actually served,
  // which is not guaranteed to be the one requested. Refuse a mismatch rather
  // than stamping the requested currency onto a number scoped to a different
  // market, the same position Kiwi's adapter takes: this codebase never
  // converts, it only refuses.
  //
  // An ABSENT echo is refused too, for the reason written out in
  // src/supplier/kiwi.ts. The captured fixture always carries
  // `search_parameters.currency: "EUR"`, so requiring it costs nothing against
  // the real API.
  const echoed = data.search_parameters?.currency
  if (echoed !== params.currency) {
    throw new UnusableResponseError(
      `searchapi: requested currency ${params.currency} but response is `
    + `${echoed ?? 'absent, the response did not say and we do not assume'}`)
  }

  const exp = minorUnitExponent(params.currency)
  const scale = 10 ** exp
  const nights = nightsBetween(params.checkIn, params.checkOut)
  const out: SupplierItem[] = []

  for (const p of data.properties ?? []) {
    const token = p.property_token
    if (!token) continue
    const picked = pickPrice(p)
    if (!picked) continue                       // no usable price, so drop it, never default it

    out.push({
      sourceId: token,
      supplier: 'searchapi',
      kind: 'hotel',
      name: p.name ?? token,
      // The ONE float to bigint conversion, rounded for the reason
      // src/supplier/kiwi.ts gives.
      price: money(BigInt(Math.round(picked.amount * scale)), params.currency),
      priceBasis: picked.basis,
      fetchedAt: now,
      ttlSeconds: SEARCHAPI_CAPABILITIES.maxAgeSeconds,
      // Supplier-supplied and therefore untrusted. It is kept on the item and
      // it never reaches her and never reaches the model: `itemForModel`
      // (src/tools.ts) drops it, and lesson 4.6 builds every link she clicks
      // server side against an allowlisted host.
      bookingUrl: p.link ?? null,
      detail: {
        kind: 'hotel',
        checkIn: params.checkIn, checkOut: params.checkOut, nights,
        rating: typeof p.rating === 'number' ? p.rating : null,
        coordinates: p.gps_coordinates
          ? { lat: p.gps_coordinates.latitude, lon: p.gps_coordinates.longitude }
          : null,
        offerSource: p.offers?.[0]?.source ?? null,
      },
    })
  }
  return out
}

function pickPrice(p: Property): { amount: number; basis: PriceBasis } | null {
  const total = p.total_price?.extracted_price
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return { amount: total, basis: 'total' }
  }
  const pre = p.total_price?.extracted_price_before_taxes
  if (typeof pre === 'number' && Number.isFinite(pre) && pre > 0) {
    return { amount: pre, basis: 'pre_tax' }
  }
  return null
}

export class SearchApiHotels implements Supplier {
  readonly name = 'searchapi'
  readonly kind = 'hotel' as const
  readonly capabilities = SEARCHAPI_CAPABILITIES

  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    // Fail at construction, not at request time: a missing key discovered
    // mid-turn costs a turn, discovered at boot it costs a restart. The key is
    // read from process.env at the construction site (src/supplier/live.ts) and
    // is deliberately NOT in src/env.ts's KEYS list, because loadEnv fails
    // fast and demanding a SearchApi account would stop `npm run trip` for
    // every reader who has not got one.
    if (!apiKey) throw new Error('SearchApiHotels: api key is required')
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]> {
    if (params.kind !== 'hotel') throw new TypeError('SearchApiHotels: hotel searches only')
    const url = new URL(ENDPOINT)
    url.searchParams.set('engine', 'google_hotels')
    url.searchParams.set('q', params.query)
    url.searchParams.set('check_in_date', params.checkIn)
    url.searchParams.set('check_out_date', params.checkOut)
    url.searchParams.set('adults', String(params.adults))
    url.searchParams.set('currency', params.currency)
    url.searchParams.set('api_key', this.apiKey)

    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`searchapi: HTTP ${res.status}`)
    return parseSearchApiHotels(await res.text(), params, this.now())
  }

  async quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome> {
    if (params.kind !== 'hotel') throw new TypeError('SearchApiHotels: hotel searches only')
    let items: SupplierItem[]
    try {
      items = await this.search(params, signal)
    } catch (err) {
      return { status: 'unavailable', reason: `searchapi re-quote failed: ${String(err)}` }
    }
    const found = items.find((i) => i.sourceId === sourceId)
    return found ? { status: 'ok', item: found } : { status: 'gone' }
  }
}
