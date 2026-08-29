/**
 * Kept out of both `mock.ts` and any live adapter: the mock supplier needs
 * `nightsBetween` to size a fabricated hotel stay, and a later production
 * hotel adapter needs the exact same date math to size a real one. Neither
 * should import the other, so this is the neutral module both depend on.
 */

/** Dates only — no times, no zones. Both bounds are ISO yyyy-mm-dd. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`)
  const b = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError('nightsBetween: bad ISO date')
  return Math.round((b - a) / 86_400_000)
}
