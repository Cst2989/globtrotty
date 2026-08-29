import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const Body = z.object({ turnId: z.string().min(1) })

export type TierRequest = {
  /** The x-worker-secret header, or null when it was not sent. */
  secret: string | null
  /** The parsed JSON body, or null when the body was not JSON. */
  body: unknown
}

export type TierDecision =
  | { kind: 'run'; turnId: string }
  | { kind: 'reject'; status: 401; body: 'unauthorized' }
  | { kind: 'reject'; status: 400; body: 'bad request' }

/**
 * Constant-time secret comparison. `timingSafeEqual` throws on a length
 * mismatch rather than returning false, so the length is checked first and
 * this function returns early on a mismatch. That early return is not
 * constant-time: it leaks, through timing, whether a guess has the right
 * length, and nothing more.
 */
export function secretsMatch(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The whole authentication story for tier 3, in one pure function. This endpoint
 * is publicly reachable and starts a run, so without the check below it is an
 * endpoint that spends money for anyone who finds it.
 *
 * The secret is compared before the body is looked at, so a caller who does not
 * hold it learns nothing about what a well formed body would be.
 */
export function authorize(request: TierRequest, expected: string): TierDecision {
  if (!secretsMatch(request.secret, expected)) {
    return { kind: 'reject', status: 401, body: 'unauthorized' }
  }
  const parsed = Body.safeParse(request.body)
  if (!parsed.success) {
    return { kind: 'reject', status: 400, body: 'bad request' }
  }
  return { kind: 'run', turnId: parsed.data.turnId }
}
