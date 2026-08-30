/**
 * Kept out of both `mock.ts` and any live adapter: the mock supplier needs
 * `nightsBetween` to size a fabricated hotel stay, and lesson 4.2's real hotel
 * adapter needs the exact same date math to size a real one. Neither should
 * import the other, so this is the neutral module both depend on.
 */

/** Dates only, no times and no zones. Both bounds are ISO yyyy-mm-dd. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  // The explicit Z is load bearing. Date.parse treats a bare 'yyyy-mm-dd' as
  // UTC and anything carrying a time as local, so an implementation that mixed
  // the two forms would be off by the offset at one end and not the other. The
  // suite pins a non-UTC zone (vitest.config.ts) precisely so that mistake
  // fails a test rather than passing on the reviewer's machine.
  const a = Date.parse(`${checkIn}T00:00:00Z`)
  const b = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError('nightsBetween: bad ISO date')
  return Math.round((b - a) / 86_400_000)
}
