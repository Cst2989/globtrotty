/**
 * Spec section 5, point 5: every URL she is handed is built server-side from a
 * supplier's own link, the final hostname is checked, and our tracking ref is
 * embedded so a conversion can be joined back to a click.
 *
 * The parameter name is ours to choose until an affiliate programme is joined;
 * when one is, the per-supplier adapter renames it in one place. Spec
 * deviation 2 (plan 3b): hotel links point at each property's own site, so
 * SearchApi's check is "a real https host", not a fixed allowlist.
 */
export const TRACKING_PARAM = 'gt_ref'

export class BookingUrlError extends Error {
  constructor(msg: string) { super(msg); this.name = 'BookingUrlError' }
}

export function isRegistrableHost(hostname: string): boolean {
  if (hostname.length === 0 || hostname === 'localhost') return false
  if (hostname.startsWith('[')) return false                       // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false        // IPv4 literal
  return hostname.includes('.')
}

export const isKiwiHost = (h: string): boolean => h === 'kiwi.com' || h.endsWith('.kiwi.com')

export function withTracking(raw: string, trackingRef: string, allow: (hostname: string) => boolean): string {
  let u: URL
  try { u = new URL(raw) } catch { throw new BookingUrlError(`not a URL: ${raw.slice(0, 80)}`) }
  if (u.protocol !== 'https:') throw new BookingUrlError(`refusing non-https link (${u.protocol})`)
  if (u.username !== '' || u.password !== '') throw new BookingUrlError('refusing link with credentials')
  if (!allow(u.hostname)) throw new BookingUrlError(`host not allowed: ${u.hostname}`)
  u.searchParams.delete(TRACKING_PARAM)
  u.searchParams.append(TRACKING_PARAM, trackingRef)
  return u.toString()
}
