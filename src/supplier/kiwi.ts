import { money, minorUnitExponent } from '../money.js'
import {
  DEFAULT_MAX_AGE_SECONDS,
  type Supplier, type SupplierItem, type SupplierCapabilities, type SearchParams,
  type FlightSearch, type QuoteOutcome, type LegSummary,
} from './types.js'

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
  segments?: { carrier?: string; carrierName?: string }[]
}
type KiwiItinerary = {
  id: string; price: number; priceFormatted?: string
  totalDurationSeconds: number; bookingUrl: string | null
  baggage: { personalItem: number; cabinBag: number; checkedBag: number }
  outbound: KiwiLeg; inbound: KiwiLeg | null
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
  if (data.currency && data.currency !== params.currency) {
    throw new Error(
      `kiwi: requested currency ${params.currency} but response is ${data.currency}`)
  }

  const exp = minorUnitExponent(params.currency)
  const scale = 10 ** exp
  return (data.itineraries ?? []).map((it) => {
    if (!Number.isFinite(it.price)) throw new Error(`kiwi: non-finite price on ${it.id}`)
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
        baggage: it.baggage,
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
