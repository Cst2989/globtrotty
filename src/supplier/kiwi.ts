import { money, minorUnitExponent } from '../money.js'
import {
  DEFAULT_MAX_AGE_SECONDS,
  type Supplier, type SupplierItem, type SupplierCapabilities, type SearchParams,
  type FlightSearch, type QuoteOutcome, type LegSummary,
} from './types.js'
import { withTracking, isKiwiHost, BookingUrlError } from './urls.js'

const ENDPOINT = 'https://mcp.kiwi.com'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Kiwi wants dd/mm/yyyy; everything in this system is ISO. Convert at the edge. */
export function toKiwiDate(iso: string): string {
  if (!ISO_DATE.test(iso)) throw new RangeError(`toKiwiDate: expected ISO yyyy-mm-dd, got ${iso}`)
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

type KiwiLeg = {
  from: string; to: string; departureTime: string; arrivalTime: string
  stops: number; route: string[]; cabinClass: string
  segments?: { carrier?: string; carrierName?: string; flightNumber?: string }[]
}
type KiwiItinerary = {
  id: string; price: number; priceFormatted?: string
  totalDurationSeconds: number; bookingUrl: string | null
  baggage?: Partial<{ personalItem: number; cabinBag: number; checkedBag: number }>
  outbound: KiwiLeg; inbound: KiwiLeg | null
}

/**
 * §13 makes baggage load-bearing for the recommendation: a €30 fare with no
 * cabin bag is not cheaper than a €55 fare with one, and the card says so. The
 * fixture always carries the object, but the field was typed as required and
 * never checked, so a response that omitted it produced
 * `detail.baggage === undefined` — which reads downstream as "we have no idea"
 * and renders as nothing at all. Zero is the honest floor: it claims no
 * allowance we were not told about, and it is the value that makes the
 * comparison conservative rather than flattering.
 */
const NO_BAGGAGE = { personalItem: 0, cabinBag: 0, checkedBag: 0 } as const

function baggageOf(it: KiwiItinerary): { personalItem: number; cabinBag: number; checkedBag: number } {
  const b = it.baggage
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  if (!b || typeof b !== 'object') return { ...NO_BAGGAGE }
  return { personalItem: n(b.personalItem), cabinBag: n(b.cabinBag), checkedBag: n(b.checkedBag) }
}

/**
 * Pure: SSE text in, normalised items out. Separated from the fetch so the whole
 * parse is testable against a committed fixture with no network — which is also
 * the only way the float and naive-timestamp hazards below get regression cover.
 */
export function parseKiwiResponse(
  body: string, params: FlightSearch, now: Date,
): SupplierItem[] {
  const payload = extractJsonRpc(body)
  if (payload.error) throw new Error(`kiwi: JSON-RPC error ${JSON.stringify(payload.error)}`)
  const text = payload.result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('kiwi: response carried no text content')

  // The tool result is a JSON STRING inside the JSON-RPC envelope: parsed twice.
  const data = JSON.parse(text) as {
    currency?: string; itineraries?: KiwiItinerary[]; error?: unknown
  }
  if (data.error) throw new Error(`kiwi: ${String(data.error)}`)

  // Currency is a request parameter, so a mismatch means the market was scoped
  // differently than we asked. Refuse — this codebase never converts.
  //
  // An ABSENT echo is refused too, and that is the whole point of the check.
  // The previous `if (data.currency && ...)` treated a missing field as
  // agreement, which is "absence of evidence is confirmation": the requested
  // code would have been stamped onto whatever number came back. This branch
  // takes the same position the rest of the codebase already takes —
  // `checkFreshness` calls an unparseable timestamp STALE, and `quote()` calls
  // a transport failure `unavailable` — because unknown is not unchanged. The
  // captured fixture always carries `currency: "EUR"`, so requiring it costs
  // nothing against the real API.
  if (data.currency !== params.currency) {
    throw new Error(
      `kiwi: requested currency ${params.currency} but response is `
    + `${data.currency ?? 'absent — the response did not say, and we do not assume'}`)
  }

  const exp = minorUnitExponent(params.currency)
  const scale = 10 ** exp
  return (data.itineraries ?? []).map((it) => {
    // `> 0`, not merely finite. A zero (or negative) price would sail through a
    // finiteness check and then be the cheapest option in every budget and
    // ranking comparison — the most attractive possible answer and an entirely
    // fictional one. Symmetrical with `pickPrice` in searchapi.ts, which drops
    // a property rather than default it to zero; here there is no fallback
    // price to fall back TO, so the whole response is refused.
    if (!Number.isFinite(it.price) || it.price <= 0) {
      throw new Error(`kiwi: unusable price ${it.price} on ${it.id}`)
    }
    // The ONE float->bigint conversion. Round, never truncate: 454.0*100 can
    // land on 45399.999... in binary floating point and Math.trunc would lose a cent.
    const minor = BigInt(Math.round(it.price * scale))
    return {
      sourceId: it.id,
      supplier: 'kiwi',
      kind: 'flight' as const,
      name: `${it.outbound.from}-${it.outbound.to}`,
      price: money(minor, params.currency),
      priceBasis: 'total' as const,
      fetchedAt: now,
      ttlSeconds: KIWI_CAPABILITIES.maxAgeSeconds,
      bookingUrl: it.bookingUrl ?? null,
      detail: {
        kind: 'flight' as const,
        outbound: leg(it.outbound),
        inbound: it.inbound ? leg(it.inbound) : null,
        baggage: baggageOf(it),
        totalDurationSeconds: it.totalDurationSeconds,
        // The API does not echo allow_self_transfer, so it is recorded from the
        // request. Kiwi's virtual interlining defaults to TRUE: a missed
        // connection is the traveller's problem, and the card must say so.
        selfTransfer: params.allowSelfTransfer,
      },
    }
  })
}

/**
 * Times arrive as naive local ISO with no offset ("2026-09-12T16:40:00"). They
 * stay strings. `new Date(...)` on one of these applies the SERVER's timezone,
 * which silently shifts every downstream date-window comparison by hours.
 */
function leg(l: KiwiLeg): LegSummary {
  return {
    from: l.from, to: l.to,
    departureLocal: l.departureTime, arrivalLocal: l.arrivalTime,
    stops: l.stops, route: l.route, cabinClass: l.cabinClass,
    carriers: [...new Set((l.segments ?? []).map((s) => s.carrier ?? s.carrierName ?? '')
      .filter(Boolean))],
    // Segment ORDER, not a deduplicated set — see LegSummary.flightNumbers.
    // `carriers` dedupes because "who flies this" is a set; a flight number is
    // per-segment identity and two segments on the same carrier have two of
    // them. Empty entries are dropped rather than kept as '' so the list holds
    // only numbers we were actually told.
    flightNumbers: (l.segments ?? []).map((s) => s.flightNumber ?? '').filter(Boolean),
  }
}

type JsonRpc = { result?: { content?: { text?: string }[] }; error?: unknown }

/** The response is text/event-stream; the payload is the last `data:` line. */
function extractJsonRpc(body: string): JsonRpc {
  const lines = body.split('\n').filter((l) => l.startsWith('data: '))
  const raw = lines.length > 0 ? lines[lines.length - 1]!.slice(6) : body
  return JSON.parse(raw) as JsonRpc
}

export const KIWI_CAPABILITIES: SupplierCapabilities = {
  live: true,
  // Verified: itinerary ids are stable across repeated identical searches
  // (15/15 matched on id and price), so quote() is a real re-search-and-find.
  mayRequote: true,
  // Shared with MockSupplier's freshness window — see DEFAULT_MAX_AGE_SECONDS's
  // doc comment in types.ts. Not a fresh literal: one definition, two consumers.
  maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
  pricePersistence: 'session',
}

export class KiwiSupplier implements Supplier {
  readonly name = 'kiwi'
  readonly kind = 'flight' as const
  readonly capabilities = KIWI_CAPABILITIES
  constructor(private readonly now: () => Date = () => new Date()) {}

  async search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]> {
    if (params.kind !== 'flight') throw new TypeError('KiwiSupplier: flight searches only')
    const body = await this.call(params, signal)
    return parseKiwiResponse(body, params, this.now())
  }

  /**
   * Re-runs the stored search and finds the itinerary by its native id. An id
   * that is absent means the fare is gone; a transport failure means we could
   * not verify — and unknown is NOT unchanged, so that surfaces as
   * `unavailable` and blocks the hand-off rather than passing quietly.
   */
  async quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome> {
    if (params.kind !== 'flight') throw new TypeError('KiwiSupplier: flight searches only')
    let items: SupplierItem[]
    try {
      items = await this.search(params, signal)
    } catch (err) {
      return { status: 'unavailable', reason: `kiwi re-quote failed: ${String(err)}` }
    }
    const found = items.find((i) => i.sourceId === sourceId)
    return found ? { status: 'ok', item: found } : { status: 'gone' }
  }

  bookingUrl(item: SupplierItem, trackingRef: string): string {
    if (item.bookingUrl === null) throw new BookingUrlError('kiwi item carries no deep link')
    return withTracking(item.bookingUrl, trackingRef, isKiwiHost)
  }

  private async call(p: FlightSearch, signal?: AbortSignal): Promise<string> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 accept: 'application/json, text/event-stream' },
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'search-flight',
          arguments: {
            flyFrom: p.from, flyTo: p.to,
            departureDate: toKiwiDate(p.departureDate),
            departureDateFlexDays: p.flexDays,
            ...(p.returnDate
              ? { returnDate: toKiwiDate(p.returnDate), returnDateFlexDays: p.flexDays }
              : {}),
            adults: p.adults, children: p.children, infants: p.infants,
            cabinClass: p.cabinClass, currency: p.currency,
            ...(p.maxStops !== null ? { max_sector_stopovers: p.maxStops } : {}),
            allow_self_transfer: p.allowSelfTransfer,
          },
        },
      }),
    })
    if (!res.ok) throw new Error(`kiwi: HTTP ${res.status}`)
    return await res.text()
  }
}
