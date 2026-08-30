import {
  APIConnectionError, APIError, APIUserAbortError, AuthenticationError, BadRequestError,
  NotFoundError, PermissionDeniedError, RateLimitError,
} from '@anthropic-ai/sdk/core/error'
// Types only, erased at compile time: this import contributes nothing to the bundle.
import type { Message, RefusalStopDetails } from '@anthropic-ai/sdk/resources/messages'

/**
 * The failure taxonomy, and the pure function that maps a thrown value onto it.
 *
 * Plan 1 mapped EVERY error to 'provider_down' and said so in a comment: the echo
 * agent could not produce a real provider error, so the classifier was deferred to
 * the plan that brings the model client. This is that classifier, arriving one plan
 * ahead of the client so the client is not also the thing that invents the taxonomy.
 *
 * WHY THIS FILE DEPENDS ON @anthropic-ai/sdk (choice (a), not a structural matcher):
 *
 *  - The taxonomy IS the SDK's error hierarchy. Classifying on `instanceof` against
 *    the classes the SDK actually throws makes the SDK the single source of truth;
 *    a hand-written `status`/constructor-name matcher is a SECOND description of
 *    the same thing, and the two can disagree with nothing to notice.
 *  - It fails loudly. If a class is renamed or removed, `pnpm typecheck` breaks on
 *    the import. A structural matcher just quietly stops matching, and every model
 *    failure starts landing in the `unclassified` bucket with no test going red.
 *  - `APIConnectionError` (the most common transient failure, and one we DO want
 *    retried) carries no HTTP status at all. Structurally it is indistinguishable
 *    from a bare `Error` except by constructor name, which is exactly the brittle
 *    match the alternative was meant to avoid. `instanceof` gets it exactly right.
 *  - The dependency arrives in plan 3 regardless; taking it here costs one entry in
 *    package.json and buys a classifier whose tests exercise the real classes
 *    (built through the SDK's own `APIError.generate`) instead of a mock shape.
 *
 * The file stays PURE: type declarations, class definitions and `instanceof`; no
 * client is constructed, no I/O happens, nothing is read from the environment. It
 * imports neither the worker nor the engine, so it cannot pull the harness into a
 * cycle; `worker.ts` is where a `ClassifiedReason` meets `failTurn`'s `FailReason`,
 * and that call site is what compile-checks the two unions against each other.
 */

/**
 * The subset of `FailReason` (src/engine.ts) this classifier can produce.
 * Deliberately declared here rather than imported, so `errors.ts` stays free of
 * the engine; the assignment in `worker.ts` is the compile-time check that every
 * value below is a real `FailReason`.
 *
 *  - `provider_down`      transient. The provider is unwell (429, 5xx). Retrying
 *                         is the correct response.
 *  - `fetch_failed`       transient, and the request never arrived. The network
 *                         did not reach the provider, so the provider has no
 *                         opinion about it and its status page will not explain
 *                         it. Retrying is correct, and looking upstream is not.
 *  - `provider_rejected`  permanent. The provider looked at THIS request and said
 *                         no, and will say no again: 400 malformed, 401 bad key,
 *                         403 not permitted, 404 wrong model. An operator must
 *                         change something before it can succeed.
 *  - `refused`            the model declined on policy grounds. HTTP 200, not an
 *                         exception; see `throwIfRefused` below.
 *  - `unclassified`       we do not recognise this error. Recorded as itself
 *                         rather than folded into `provider_down`, because we have
 *                         no evidence the provider was involved at all: a
 *                         TypeError in our own code lands here, as does worker.ts's
 *                         own "'park' is not implemented" throw. A rising count of
 *                         these is a signal that the classifier needs a new rule:
 *                         a signal `provider_down` would have hidden.
 */
export type ClassifiedReason =
  | 'provider_down' | 'fetch_failed' | 'provider_rejected' | 'refused' | 'unclassified'

/**
 * WHAT `retryable` DOES NOT MEAN.
 *
 * Nothing in this harness retries a classified failure, and nothing did before
 * this classifier existed. `failTurn` sets `status = 'failed'`
 * (src/repo/turns.ts), and the sweeper only ever considers `'queued'` or
 * `'running'` rows (src/sweeper.ts), so every classified failure is terminal,
 * whatever this flag says. `retryable: true` on a row means "this error was the
 * kind worth retrying", NOT "this turn was retried".
 *
 * The flag is advice for the model client plan 3 brings (honour Retry-After,
 * back off, give up) and for whoever decides (deliberately, and not by
 * inheriting an assumption from this comment) whether the harness should ever
 * requeue a failed turn. The taxonomy exists so that decision CAN be made; it
 * does not make it.
 */
export type Classification = { retryable: boolean; reason: ClassifiedReason }

const TRANSIENT: Classification = { retryable: true, reason: 'provider_down' }
/**
 * Transient, and the request never reached the provider: a socket hung up, DNS
 * failed, a timeout expired with no response at all. Separated from
 * `provider_down` because a row that says one when it means the other sends
 * whoever is on call to the wrong status page. Both are retryable, so this
 * changes what we record and not what we do.
 */
const UNREACHED: Classification = { retryable: true, reason: 'fetch_failed' }
const PERMANENT: Classification = { retryable: false, reason: 'provider_rejected' }
const REFUSED: Classification = { retryable: false, reason: 'refused' }
/**
 * FAIL CLOSED. An error we cannot name is NOT retryable.
 *
 * Read `retryable` as advice to a caller that does not exist yet; see the note
 * on WHAT `retryable` DOES NOT MEAN, below. The question this answers is what a
 * future retry mechanism should be told about an error nobody has classified.
 *
 * Both directions cost something, so the choice is which cost to prefer. This
 * bucket is the one that catches OUR OWN bugs: a TypeError is deterministic, so
 * retrying it is guaranteed waste, and an unknown error's recurrence properties
 * are by definition unmodelled; retrying is an unbounded-cost bet on behaviour
 * we have not characterised. Declining costs at most one turn, which is visible
 * (`unclassified` on the row) and which the user can resend. Same instinct as
 * `readSpendFailClosed`: when we cannot confirm, we take the conservative side
 * rather than the optimistic one.
 */
const UNKNOWN: Classification = { retryable: false, reason: 'unclassified' }

/**
 * Statuses worth retrying, matching the SDK's own retry policy (408 request
 * timeout, 409 conflict, 429 rate limit, and every 5xx). Kept as a predicate over
 * the number rather than a list of classes because `APIError.generate` only mints
 * a dedicated subclass for some of them; 408 arrives as a bare `APIError`.
 */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function byStatus(status: number | undefined): Classification {
  if (status === undefined) return UNKNOWN
  if (retryableStatus(status)) return TRANSIENT
  // Any other 4xx is the provider rejecting this exact request. Below 400 is not
  // an error status at all, so an error carrying one is not something we can read.
  return status >= 400 && status < 500 ? PERMANENT : UNKNOWN
}

/**
 * A model refusal, converted into something the harness can handle.
 *
 * `stop_reason: "refusal"` is an HTTP 200 with a populated `stop_details`. It does
 * not throw, so a harness that only inspects exceptions reads it as a successful
 * turn that produced no content and hands the user an empty answer with no failure
 * recorded anywhere. The model client (plan 3) checks `stop_reason` BEFORE reading
 * `content` and throws this; that keeps runTurn's single failure path (the catch
 * around the loop), the only place a turn is failed, instead of bolting a second,
 * parallel one beside it.
 */
export class RefusalError extends Error {
  readonly category: RefusalStopDetails['category']
  readonly explanation: string | null

  constructor(category: RefusalStopDetails['category'], explanation: string | null = null) {
    super(`model refused the request (category: ${category ?? 'unknown'})`)
    this.name = 'RefusalError'
    this.category = category
    this.explanation = explanation
  }
}

/** The narrowest shape that can answer "was this a refusal?": a full `Message` fits. */
export type StopSignal = Pick<Message, 'stop_reason' | 'stop_details'>

export function isRefusal(message: StopSignal): boolean {
  return message.stop_reason === 'refusal'
}

/**
 * Call this on every response, BEFORE reading `content`. `stop_details` is
 * documented as populated for a refusal, but its absence does not make the turn
 * any less refused; the category is then simply unknown.
 */
export function throwIfRefused(message: StopSignal): void {
  if (!isRefusal(message)) return
  const details = message.stop_details
  throw new RefusalError(details?.category ?? null, details?.explanation ?? null)
}

/**
 * Maps an unknown thrown value to `{ retryable, reason }`.
 *
 * Ordered most specific FIRST. A single broad `instanceof APIError` would collapse
 * the retryable/non-retryable distinction, which is the entire point of the
 * function: a permanent 400 and a transient 429 must not be recorded (or, when
 * plan 3 gives retry a home, treated) as the same thing.
 */
export function classifyError(err: unknown): Classification {
  // Not an exception the provider raised: the model answered 200 and declined.
  if (err instanceof RefusalError) return REFUSED

  // Permanent request faults. One reason covers all four: the operator action
  // differs (fix the request, the key, the entitlement, the model id) but the
  // harness's decision is identical: never retry, surface it, stop.
  if (err instanceof BadRequestError) return PERMANENT
  if (err instanceof AuthenticationError) return PERMANENT
  if (err instanceof PermissionDeniedError) return PERMANENT
  if (err instanceof NotFoundError) return PERMANENT

  if (err instanceof RateLimitError) return TRANSIENT

  // No status on either of these. APIConnectionError (and its timeout subclass) is
  // the network never reaching the provider: retryable. APIUserAbortError is OUR
  // abort: nothing is wrong upstream and the same call would abort again, so it is
  // not a provider failure and must not be recorded as one.
  if (err instanceof APIUserAbortError) return UNKNOWN
  if (err instanceof APIConnectionError) return UNREACHED

  // Everything else the SDK raises with a status: 5xx, 409, 422, 408, and any
  // status the SDK does not (yet) mint a subclass for.
  if (err instanceof APIError) return byStatus(err.status)

  /**
   * Structural fallback, deliberately AFTER the whole `instanceof` chain and
   * deliberately narrow. `instanceof` fails silently in two real situations: two
   * copies of the SDK in node_modules (the thrown class is not the imported one),
   * and a differently-packaged client for the same API (Bedrock, Vertex) whose
   * errors carry an HTTP status but not these classes. Matching a numeric `status`
   * on an `Error` recovers those.
   *
   * The `instanceof Error` guard is the narrowing that matters: a plain object
   * with a `status` field is ordinary JSON, and reading a provider verdict out of
   * an arbitrary thrown payload would be a worse failure than not classifying it.
   */
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status
    if (typeof status === 'number') return byStatus(status)
  }

  /**
   * NOTE for plan 3, deliberately not handled here: the SDK also exports
   * `RetryableError`, an explicit "retry this" signal thrown by middleware. It
   * extends `AnthropicError`, NOT `APIError`, so it falls through every branch
   * above and lands here as `unclassified`/non-retryable. Unreachable today:
   * nothing in this repo constructs an SDK client, let alone middleware, and
   * adding a branch for it now would be a rule no test could exercise against
   * a real thrower. Whoever wires the client either registers middleware and
   * adds the branch WITH a test, or does not, in which case nothing changes.
   */
  return UNKNOWN
}
