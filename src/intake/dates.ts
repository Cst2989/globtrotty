/**
 * Calendar arithmetic for intake, in UTC throughout (`Date.UTC`, never local time — the harness
 * runs wherever Netlify schedules it, and "today" must mean the same calendar day everywhere).
 * Jev never does this math: it only picks among candidates (month names, day numbers, weekday
 * names) that code already found in her message. This module turns those picks into one ISO
 * date, or decides they don't add up to a real date at all.
 */

const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

/** Lowercase full month names, January first — the vocabulary `buildIntakeQuestions` offers Jev. */
export const MONTHS: string[] = Object.keys(MONTH_INDEX)

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/** Lowercase full weekday names mapped to `null`, ready to spread into a `choiceQ` criteria map. */
export const WEEKDAYS: Record<string, null> = Object.fromEntries(
  Object.keys(WEEKDAY_INDEX).map((w) => [w, null]),
)

const DAY_MS = 24 * 60 * 60 * 1000

function toIso(year: number, monthIndex: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Rejects calendar rollovers (Feb 30, Apr 31, ...) that `Date.UTC` would otherwise silently fix up. */
function isValidYMD(year: number, monthIndex: number, day: number): boolean {
  const d = new Date(Date.UTC(year, monthIndex, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === monthIndex && d.getUTCDate() === day
}

/**
 * Resolves the month/day/year/weekday parts `datePartCandidates` + Jev narrowed down to one ISO
 * date, or `null` when the parts don't describe a real calendar date.
 *
 * - A `weekday` (with no month/day) resolves to its next occurrence from `today` — today itself
 *   never counts, so a bare "Friday" said on a Friday means next week — plus 7 more days when
 *   `relative` is `'next'` ("next Friday" skips the immediate one).
 * - A `month`+`day` with an explicit `year` is taken as stated (`assumed: 'none'`), or rejected
 *   outright if that date doesn't exist.
 * - A `month`+`day` with no `year` assumes the nearest year that isn't more than 30 days in the
 *   past (she may be mid-trip): the current year if the date falls within 30 days before today or
 *   any time after it, otherwise next year (`assumed: 'year'`).
 */
export function resolveDate(
  parts: { month: string | null; day: number | null; year: number | null; relative?: string | null; weekday?: string | null },
  today: Date,
): { iso: string; assumed: 'year' | 'none' } | null {
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())

  if (parts.weekday) {
    const targetDow = WEEKDAY_INDEX[parts.weekday]
    if (targetDow === undefined) return null
    const todayDow = today.getUTCDay()
    let daysUntil = (targetDow - todayDow + 7) % 7
    if (daysUntil === 0) daysUntil = 7
    if (parts.relative === 'next') daysUntil += 7
    const d = new Date(todayUTC + daysUntil * DAY_MS)
    return { iso: toIso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), assumed: 'none' }
  }

  if (parts.month === null || parts.day === null) return null
  const monthIndex = MONTH_INDEX[parts.month]
  if (monthIndex === undefined) return null
  if (!Number.isInteger(parts.day) || parts.day < 1 || parts.day > 31) return null

  if (parts.year !== null) {
    if (!isValidYMD(parts.year, monthIndex, parts.day)) return null
    return { iso: toIso(parts.year, monthIndex, parts.day), assumed: 'none' }
  }

  const currentYear = today.getUTCFullYear()
  const validThisYear = isValidYMD(currentYear, monthIndex, parts.day)
  const validNextYear = isValidYMD(currentYear + 1, monthIndex, parts.day)
  if (!validThisYear && !validNextYear) return null

  let year = currentYear + 1
  if (validThisYear) {
    const candidateUTC = Date.UTC(currentYear, monthIndex, parts.day)
    const diffDays = Math.round((todayUTC - candidateUTC) / DAY_MS)
    year = diffDays <= 30 ? currentYear : currentYear + 1
    if (year === currentYear + 1 && !validNextYear) year = currentYear
  }

  return { iso: toIso(year, monthIndex, parts.day), assumed: 'year' }
}

/** Adds (or subtracts, with a negative `delta`) whole days to an ISO date, in UTC. */
export function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * DAY_MS)
  return toIso(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
}
