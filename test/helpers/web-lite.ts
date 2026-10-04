import type { ResultItemLite } from '../../web/data.js'

/**
 * `web-lite` rather than `lite` in the name, and named in tsconfig.harness.json's `exclude`:
 * this helper reaches into `web/`, which the harness project does not carry the `@/*` path
 * mapping for. Only the web-tests project (tsconfig.webtests.json) compiles it, the same split
 * `test/web-*.test.ts` already lives under.
 */

/**
 * A `ResultItemLite['hotel']` from whatever a test cares about, with everything else at its
 * "nothing known" value — the lite-shape counterpart of `hotelDetail` (src/supplier/types.ts),
 * and for the same reason: the hotels pass gave a stay twelve more fields than the four it had,
 * and a test about the rating filter has no business listing all sixteen.
 */
export function hotelLite(
  over: Partial<NonNullable<ResultItemLite['hotel']>> = {},
): NonNullable<ResultItemLite['hotel']> {
  return {
    rating: null,
    nights: 7,
    checkIn: '2026-11-19',
    checkOut: '2026-11-26',
    propertyType: 'hotel',
    stars: null,
    reviews: null,
    images: [],
    amenities: [],
    essentials: [],
    nearby: [],
    pricePerNightMinor: null,
    distanceKm: null,
    coordinates: null,
    ...over,
  }
}
