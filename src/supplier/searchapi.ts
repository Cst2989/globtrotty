import { money, minorUnitExponent } from '../money.js'
import { maskUntrustedText } from '../sanitize.js'
import { nightsBetween } from './dates.js'
import type {
  Supplier, SupplierItem, SupplierCapabilities, SearchParams, HotelSearch,
  QuoteOutcome, PriceBasis, HotelDetail, NearbyPlace,
} from './types.js'
import { withTracking, isRegistrableHost, BookingUrlError } from './urls.js'

const ENDPOINT = 'https://www.searchapi.io/api/v1/search'

type Price = {
  extracted_price?: number | null
  extracted_price_before_taxes?: number | null
}
type Transportation = { type?: string; duration?: string }
type NearbyRaw = { name?: string; transportations?: Transportation[] }
type ImageRaw = { thumbnail?: string; original?: string; original_image?: string }
type Property = {
  property_token?: string; name?: string; link?: string; type?: string
  gps_coordinates?: { latitude: number; longitude: number }
  rating?: number; total_price?: Price; price_per_night?: Price
  offers?: { source?: string }[]
  hotel_class?: string; extracted_hotel_class?: number
  reviews?: number; location_rating?: number
  images?: ImageRaw[]
  amenities?: string[]
  essential_info?: string[]
  nearby_places?: NearbyRaw[]
}

/** The caps every supplier-authored list on a hotel card is cut to. */
const MAX_IMAGES = 5
const MAX_AMENITIES = 12
const MAX_ESSENTIALS = 6
const MAX_NEARBY = 3
/** One label on a card: long enough for "Air conditioning", short enough not to be a paragraph. */
const MAX_LABEL_CHARS = 40

/**
 * The ONLY hosts a hotel photo may come from: Google's own image CDN, exactly, or any
 * `*.gstatic.com`. https only.
 *
 * This is the same allowlist `img-src` in web/csp.ts names, applied here as WELL rather than
 * instead: the CSP is the browser's backstop, this is the office refusing to put a URL it cannot
 * vouch for into its own corpus in the first place. A `javascript:` URL, an `http://` one, a
 * look-alike host (`lh3.googleusercontent.com.evil.test`) and a userinfo trick
 * (`https://lh3.googleusercontent.com@evil.test/x`) are all rejected, because `URL`'s own
 * `hostname` is what is compared and it resolves all four to something not on this list. An
 * unparseable URL is rejected too.
 */
export function allowedImageUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  return url.hostname === 'lh3.googleusercontent.com' || url.hostname.endsWith('.gstatic.com')
}

/**
 * Typographic characters a supplier's own labels legitimately carry and that
 * `maskUntrustedText` would turn into a `?`: Google writes "Free Wi‑Fi" with a NON-BREAKING
 * HYPHEN, and "Free Wi?Fi" on a card reads as corruption. Folding these to their ASCII
 * equivalents BEFORE masking is not a hole in the guard — every control character, newline and
 * anything else outside printable ASCII still becomes `?`. It only stops the guard from mangling
 * punctuation that was never an attack.
 */
const TYPOGRAPHIC_FOLD: [RegExp, string][] = [
  [/[‐-―−]/g, '-'],
  [/[‘’‛′]/g, "'"],
  [/[“”‟″]/g, '"'],
  [/[    ]/g, ' '],
  [/…/g, '...'],
]

/**
 * One supplier-authored label, ready to render: folded, masked, capped at `MAX_LABEL_CHARS` and
 * trimmed. `null` for a label that is empty once masked, so no caller ever renders a blank chip.
 */
export function maskLabel(raw: string): string | null {
  // NFD + drop the combining marks, so "Sensō-ji" is "Senso-ji" rather than "Sens?-ji". The same
  // fold `normalise` (src/intake/places.ts) applies, and the same posture `places.json`'s own
  // city names take ("Malaga", "Dusseldorf"). A script with no ASCII form (Japanese, Arabic)
  // still masks to '?', which is the honest answer: this office cannot render it.
  let folded = raw.normalize('NFD').replace(/[̀-ͯ]/g, '')
  for (const [pattern, replacement] of TYPOGRAPHIC_FOLD) folded = folded.replace(pattern, replacement)
  // Cut AFTER masking (`maskUntrustedText` documents why it masks before its own cap) and with a
  // plain slice rather than an ellipsis marker: this field is documented as printable ASCII, and
  // a '…' would put a character back outside that range.
  const masked = maskUntrustedText(folded).slice(0, MAX_LABEL_CHARS).trim()
  return masked.length > 0 ? masked : null
}

/**
 * '12 min' -> 12, '1 hr 25 min' -> 85, '2 hr' -> 120; `null` for a string carrying neither unit.
 *
 * Both units are read because SearchApi quotes both ("Taxi, 1 hr 4 min" to Haneda is a real
 * entry in the recorded Tokyo fixture) and a minutes-only parse silently threw away every
 * long-distance airport transfer — the exact line a card wants most.
 */
export function minutesFromDuration(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null
  const hours = /(\d{1,3})\s*(?:hr|hour)/i.exec(raw)
  const mins = /(\d{1,4})\s*min/i.exec(raw)
  if (!hours && !mins) return null
  const total = (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0)
  return Number.isSafeInteger(total) ? total : null
}

/** SearchApi's `type`, narrowed to the three a card can label — see `HotelDetail.propertyType`. */
export function propertyTypeOf(raw: string | undefined): HotelDetail['propertyType'] {
  if (raw === 'hotel') return 'hotel'
  if (raw === 'vacation_rental') return 'rental'
  return 'other'
}

/** Up to `MAX_IMAGES` photo URLs off one property, host-checked; the big image first, else the thumbnail. */
function imagesOf(p: Property): string[] {
  const out: string[] = []
  for (const image of p.images ?? []) {
    if (out.length >= MAX_IMAGES) break
    const candidate = [image?.original_image, image?.original, image?.thumbnail]
      .find((u): u is string => typeof u === 'string' && allowedImageUrl(u))
    if (candidate !== undefined) out.push(candidate)
  }
  return out
}

/** Up to `cap` masked labels off a raw string list, dropping anything that masks to nothing. */
function labelsOf(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (out.length >= cap) break
    if (typeof entry !== 'string') continue
    const label = maskLabel(entry)
    if (label !== null) out.push(label)
  }
  return out
}

/**
 * Up to `MAX_NEARBY` nearby places. The FIRST transportation is the one kept: SearchApi lists
 * them fastest first (a taxi before the same trip by bus), and a card has room for one.
 */
function nearbyOf(p: Property): NearbyPlace[] {
  const out: NearbyPlace[] = []
  for (const entry of p.nearby_places ?? []) {
    if (out.length >= MAX_NEARBY) break
    if (typeof entry?.name !== 'string') continue
    const name = maskLabel(entry.name)
    if (name === null) continue
    const first = entry.transportations?.[0]
    out.push({
      name,
      minutes: minutesFromDuration(first?.duration),
      by: typeof first?.type === 'string' ? maskLabel(first.type) : null,
    })
  }
  return out
}

/** A number in `[0, max]`, else null — a rating outside its own range is not a rating. */
function boundedNumber(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > max) return null
  return value
}

export const SEARCHAPI_CAPABILITIES: SupplierCapabilities = {
  live: true,
  // property_token is stable across searches, so a re-quote is a re-search
  // plus a find — the same shape as Kiwi's.
  mayRequote: true,
  maxAgeSeconds: 3600,
  pricePersistence: 'session',
}

/**
 * Pure: raw JSON text in, normalised items out.
 *
 * Price selection is the load-bearing decision. We prefer the all-in
 * `total_price`, fall back to the pre-tax figure and LABEL it, and drop a
 * property that offers neither. Defaulting a missing price to zero would make
 * the unpriced hotel the cheapest option in every budget comparison — the most
 * attractive possible answer, and entirely fictional.
 */
export function parseSearchApiHotels(
  body: string, params: HotelSearch, now: Date,
): SupplierItem[] {
  const data = JSON.parse(body) as {
    search_parameters?: { currency?: string }
    properties?: Property[]
    error?: unknown
  }
  if (data.error) throw new Error(`searchapi: ${String(data.error)}`)

  // search_parameters.currency echoes the currency SearchApi actually served,
  // which is not guaranteed to be the one requested. Refuse a mismatch rather
  // than stamping the requested currency onto a number scoped to a different
  // market — same position as Kiwi (src/supplier/kiwi.ts): this codebase
  // never converts, it only refuses.
  //
  // An ABSENT echo is refused too. `if (echoed && ...)` treated a missing field
  // as agreement and stamped the requested code onto whatever number came back
  // — "absence of evidence is confirmation", and the exact opposite of the
  // position taken by `checkFreshness` (an unparseable timestamp is STALE) and
  // `quote()` (a transport failure is `unavailable`). The captured fixture
  // always carries `search_parameters.currency: "EUR"`, so requiring it costs
  // nothing against the real API.
  const echoed = data.search_parameters?.currency
  if (echoed !== params.currency) {
    throw new Error(
      `searchapi: requested currency ${params.currency} but response is `
    + `${echoed ?? 'absent — the response did not say, and we do not assume'}`)
  }

  const exp = minorUnitExponent(params.currency)
  const scale = 10 ** exp
  const nights = nightsBetween(params.checkIn, params.checkOut)
  const out: SupplierItem[] = []

  for (const p of data.properties ?? []) {
    const token = p.property_token
    if (!token) continue
    const picked = pickPrice(p)
    if (!picked) continue                       // no usable price -> drop, never default
    const rawPerNight = p.price_per_night?.extracted_price
    const perNight = typeof rawPerNight === 'number' && Number.isFinite(rawPerNight) && rawPerNight > 0
      ? rawPerNight
      : null

    out.push({
      sourceId: token,
      supplier: 'searchapi',
      kind: 'hotel',
      name: p.name ?? token,
      // The ONE float->bigint conversion. Round, never truncate: 8.29*100
      // lands on 828.9999999999999 in binary floating point (verified via
      // `node -e`) and Math.trunc would lose a cent.
      price: money(BigInt(Math.round(picked.amount * scale)), params.currency),
      priceBasis: picked.basis,
      fetchedAt: now,
      ttlSeconds: SEARCHAPI_CAPABILITIES.maxAgeSeconds,
      // Supplier-supplied and therefore untrusted: §10's host allowlist applies
      // before this is ever emitted to the user.
      bookingUrl: p.link ?? null,
      detail: {
        kind: 'hotel',
        checkIn: params.checkIn, checkOut: params.checkOut, nights,
        rating: boundedNumber(p.rating, 5),
        coordinates: p.gps_coordinates
          ? { lat: p.gps_coordinates.latitude, lon: p.gps_coordinates.longitude }
          : null,
        offerSource: p.offers?.[0]?.source ?? null,
        propertyType: propertyTypeOf(p.type),
        stars: boundedNumber(p.extracted_hotel_class, 5),
        reviews: typeof p.reviews === 'number' && Number.isFinite(p.reviews) && p.reviews >= 0
          ? Math.round(p.reviews)
          : null,
        locationRating: boundedNumber(p.location_rating, 5),
        images: imagesOf(p),
        amenities: labelsOf(p.amenities, MAX_AMENITIES),
        essentials: labelsOf(p.essential_info, MAX_ESSENTIALS),
        nearby: nearbyOf(p),
        // Same single float->bigint conversion as the total above, same rounding, and the same
        // refusal to invent one: a property with no per-night figure gets `null`, and the card
        // prints nothing where "€112 per night" would go.
        pricePerNightMinor: perNight === null ? null : BigInt(Math.round(perNight * scale)).toString(),
        // The agent's to fill: the adapter knows what came back, not what was searched for.
        distanceKm: null,
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
    // mid-turn costs a turn, discovered at boot costs a restart.
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
    // Verified live on 2026-10-04: `q=Tokyo` alone comes back with vacation rentals in the
    // United States. `gl` is the market Google searches in and it is what makes a Tokyo query
    // return Tokyo hotels; `hl=en` keeps the labels this office renders in one language, since
    // amenity and essential-info strings go straight onto a card. No `gl` at all for a
    // destination whose country we do not know, rather than a guessed market.
    if (params.countryCode) url.searchParams.set('gl', params.countryCode.toLowerCase())
    url.searchParams.set('hl', 'en')
    // Relevance, explicitly, because it is the order Jev's own re-rank is applied ON TOP of
    // (src/intake/rank.ts). Asking for `lowest_price` here would hand Jev a page already sorted
    // by the one thing it is meant to weigh against everything else.
    url.searchParams.set('sort_by', 'relevance')
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

  bookingUrl(item: SupplierItem, trackingRef: string): string {
    if (item.bookingUrl === null) throw new BookingUrlError('searchapi item carries no link')
    return withTracking(item.bookingUrl, trackingRef, isRegistrableHost)
  }
}
