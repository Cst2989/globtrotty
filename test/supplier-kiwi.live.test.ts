// Opt-in live smoke test: hits the real Kiwi MCP endpoint. A fixture proves the
// parser; it cannot prove the endpoint still speaks the shape the parser
// expects. Gated on LIVE_SUPPLIERS so the default `pnpm test` run stays
// offline — same pattern as `describeDb` in test/helpers/db.ts.
import { describe, expect, it } from 'vitest'
import { KiwiSupplier } from '../src/supplier/kiwi.js'
import type { FlightSearch } from '../src/supplier/types.js'

const live = process.env.LIVE_SUPPLIERS === '1' ? describe : describe.skip

// Kept comfortably in the future so the search never goes empty as time passes.
const departureDate = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
const returnDate = new Date(Date.now() + 67 * 86_400_000).toISOString().slice(0, 10)

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate, returnDate, flexDays: 0,
  adults: 1, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

live('KiwiSupplier (live)', () => {
  it('returns priced itineraries in the requested currency, on the requested date, with a strict shape', async () => {
    const items = await new KiwiSupplier().search(params)
    expect(items.length).toBeGreaterThan(0)

    // Price: never a float leaving the adapter. Do not pin an exact amount —
    // real prices move — but the type, sign and currency are load-bearing.
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
    }

    // Ids: non-empty and unique per item, since quote() finds by id.
    const ids = items.map((i) => i.sourceId)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)

    // Timestamps: naive local ISO, no offset suffix — see LegSummary's contract.
    for (const i of items) {
      expect(i.detail.kind).toBe('flight')
      if (i.detail.kind !== 'flight') continue
      for (const leg of [i.detail.outbound, i.detail.inbound]) {
        if (!leg) continue
        expect(leg.departureLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
        expect(leg.departureLocal).not.toMatch(/Z|[+-]\d{2}:\d{2}$/)
        expect(leg.arrivalLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
        expect(leg.arrivalLocal).not.toMatch(/Z|[+-]\d{2}:\d{2}$/)
      }
    }

    // Proves the request-side dd/mm/yyyy conversion actually reached Kiwi: if
    // toKiwiDate's wrapper were dropped and the ISO string sent instead, Kiwi
    // would either return no results (caught by the length assertion above)
    // or interpret the ISO string differently and return flights that do not
    // depart on the requested date. Pin the outbound date explicitly.
    for (const i of items) {
      if (i.detail.kind !== 'flight') continue
      expect(i.detail.outbound.departureLocal.slice(0, 10)).toBe(departureDate)
    }
  }, 90_000)

  it('re-quotes a just-searched id to ok — the property mayRequote claims', async () => {
    const s = new KiwiSupplier()
    const [first] = await s.search(params)
    expect(first).toBeDefined()
    const q = await s.quote(first!.sourceId, params)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') {
      expect(q.item.sourceId).toBe(first!.sourceId)
      expect(q.item.price.currency).toBe('EUR')
      expect(q.item.price.minor > 0n).toBe(true)
    }
  }, 180_000)

  it('reports an unknown id as gone, not as an error', async () => {
    const q = await new KiwiSupplier().quote('definitely-not-an-itinerary', params)
    expect(q.status).toBe('gone')
  }, 90_000)
})
