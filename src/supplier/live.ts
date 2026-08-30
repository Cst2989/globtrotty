import { KiwiSupplier } from './kiwi.js'
import { mockSuppliers } from './mock.js'
import { SearchApiHotels } from './searchapi.js'
import type { SupplierPair } from './types.js'

/**
 * The suppliers a live run uses, and an honest report of which ones they are.
 *
 * Kiwi needs no key, so flights are always real. SearchApi needs one, and it is
 * read from `process.env` here rather than through `src/env.ts`'s `loadEnv`:
 * `loadEnv` fails fast on a missing key, so adding GOOGLE_SEARCH_API to its
 * KEYS list would stop `npm run trip` for every reader who has not got a
 * SearchApi account, in a course where hotels are not the point of the exercise.
 * Without a key, hotels fall back to the mock and the caller is told so, because
 * a run that silently invents its hotel prices while printing real fares is
 * worse than one that says which half is real.
 */
export function liveSuppliers(): { suppliers: SupplierPair; hotelSource: 'searchapi' | 'mock' } {
  const apiKey = process.env.GOOGLE_SEARCH_API
  const flight = new KiwiSupplier()
  if (!apiKey) {
    return { suppliers: { flight, hotel: mockSuppliers().hotel }, hotelSource: 'mock' }
  }
  return { suppliers: { flight, hotel: new SearchApiHotels(apiKey) }, hotelSource: 'searchapi' }
}
