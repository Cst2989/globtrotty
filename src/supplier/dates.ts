/**
 * Kept out of both `mock.ts` and any live adapter: the mock supplier needs
 * `nightsBetween` to size a fabricated hotel stay, and lesson 4.2's real hotel
 * adapter needs the exact same date math to size a real one. Neither should
 * import the other, so this is the neutral module both depend on.
 */

/**
 * The one parse in this module, exported so a test can point at it directly.
 *
 * The explicit Z is load bearing. `Date.parse` treats a bare 'yyyy-mm-dd' as
 * UTC and anything carrying a time as local, so an implementation that appended
 * a bare `T00:00:00` lands on local midnight and is off by the running
 * process's offset. This function is the only place that can be observed: the
 * suite pins TZ=America/Los_Angeles (vitest.config.ts), so a local parse here
 * is seven or eight hours away from what this returns and
 * test/supplier-dates.test.ts fails on the exact instant.
 *
 * `nightsBetween` below cannot show that, and it is worth saying why rather
 * than claiming it does. Its `Math.round` divides a span by a whole day, so any
 * skew under twelve hours at one end rounds back to the same count: a mixed
 * implementation returns the right number of nights under every zone the suite
 * could pin, and only the instant it parsed to is ever wrong. The invariant is
 * held here, one assertion deep, rather than by a night count that cannot see
 * it.
 */
export function utcDayStart(date: string): number {
  const t = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(t)) throw new RangeError('utcDayStart: bad ISO date')
  return t
}

/** Dates only, no times and no zones. Both bounds are ISO yyyy-mm-dd. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = utcDayStart(checkIn)
  const b = utcDayStart(checkOut)
  // Both ends came out of the same zone-independent parse, so this is a whole
  // number of days before it is rounded. The rounding is left in for the
  // arithmetic's sake, not as a guard: see `utcDayStart` for what it hides.
  return Math.round((b - a) / 86_400_000)
}
