import { describe, it, expect } from 'vitest'
import {
  APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError,
  BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError,
  ConflictError, UnprocessableEntityError, RateLimitError, InternalServerError,
} from '@anthropic-ai/sdk'
import {
  classifyError, isRefusal, throwIfRefused, RefusalError,
  type Classification, type ClassifiedReason,
} from '../src/errors.js'

/**
 * Built through the SDK's OWN dispatcher rather than by calling each subclass
 * constructor by hand: `APIError.generate` is the function the SDK itself uses
 * to turn an HTTP response into a typed error, so a fixture built this way is
 * the exact object the classifier will meet in plan 3 — not our guess at one.
 * Each row asserts the class as well as the classification, so a test cannot
 * pass while silently exercising a bare `APIError`.
 */
const fromStatus = (status: number): unknown =>
  APIError.generate(
    status,
    { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } },
    undefined,
    new Headers(),
  )

type Row = {
  status: number
  cls: abstract new (...args: never[]) => Error
  retryable: boolean
  reason: ClassifiedReason
}

// Every row of the brief's taxonomy table, plus the three statuses the SDK's
// own retry policy covers that the table does not name (408, 409, 422).
const ROWS: readonly Row[] = [
  { status: 400, cls: BadRequestError, retryable: false, reason: 'provider_rejected' },
  { status: 401, cls: AuthenticationError, retryable: false, reason: 'provider_rejected' },
  { status: 403, cls: PermissionDeniedError, retryable: false, reason: 'provider_rejected' },
  { status: 404, cls: NotFoundError, retryable: false, reason: 'provider_rejected' },
  { status: 409, cls: ConflictError, retryable: true, reason: 'provider_down' },
  { status: 422, cls: UnprocessableEntityError, retryable: false, reason: 'provider_rejected' },
  { status: 429, cls: RateLimitError, retryable: true, reason: 'provider_down' },
  { status: 500, cls: InternalServerError, retryable: true, reason: 'provider_down' },
  { status: 503, cls: InternalServerError, retryable: true, reason: 'provider_down' },
]

describe('classifyError — the SDK taxonomy', () => {
  for (const row of ROWS) {
    it(`maps HTTP ${row.status} (${row.cls.name}) to ${row.reason}, retryable=${row.retryable}`, () => {
      const err = fromStatus(row.status)
      expect(err).toBeInstanceOf(row.cls)
      expect(classifyError(err)).toEqual<Classification>({
        retryable: row.retryable, reason: row.reason,
      })
    })
  }

  // 408 is not one of `APIError.generate`'s special cases, so it arrives as a
  // bare APIError carrying a status — the branch that decides by status alone.
  it('maps a bare APIError with a retryable status (408) to provider_down', () => {
    const err = fromStatus(408)
    expect(err).toBeInstanceOf(APIError)
    expect(err).not.toBeInstanceOf(RateLimitError)
    expect(classifyError(err)).toEqual<Classification>({
      retryable: true, reason: 'provider_down',
    })
  })

  it('maps a bare APIError with an unlisted 4xx status (418) to provider_rejected', () => {
    expect(classifyError(fromStatus(418))).toEqual<Classification>({
      retryable: false, reason: 'provider_rejected',
    })
  })

  it('maps a connection failure to provider_down — the retryable one that has no status', () => {
    const err = new APIConnectionError({ message: 'socket hang up' })
    expect(err.status).toBeUndefined()
    expect(classifyError(err)).toEqual<Classification>({
      retryable: true, reason: 'provider_down',
    })
  })

  it('maps a connection TIMEOUT to provider_down as well', () => {
    expect(classifyError(new APIConnectionTimeoutError({}))).toEqual<Classification>({
      retryable: true, reason: 'provider_down',
    })
  })

  // We aborted the request ourselves (deadline, abort signal). Nothing on the
  // provider's side is wrong and retrying the same call would abort again.
  it('does not treat our own abort as a provider problem', () => {
    expect(classifyError(new APIUserAbortError({}))).toEqual<Classification>({
      retryable: false, reason: 'unclassified',
    })
  })
})

describe('classifyError — a refusal', () => {
  it('maps a RefusalError to refused, and never retries it', () => {
    expect(classifyError(new RefusalError('cyber', 'nope'))).toEqual<Classification>({
      retryable: false, reason: 'refused',
    })
  })
})

describe('classifyError — the structural fallback', () => {
  // Guards the case `instanceof` cannot see: two copies of the SDK in
  // node_modules, or a provider wrapper (Bedrock/Vertex) that is not this
  // SDK's class but still carries an HTTP status.
  class ForeignHttpError extends Error {
    readonly status = 503
  }
  class ForeignPermanentError extends Error {
    readonly status = 400
  }

  it('classifies a non-SDK Error carrying a retryable status', () => {
    expect(classifyError(new ForeignHttpError('gateway'))).toEqual<Classification>({
      retryable: true, reason: 'provider_down',
    })
  })

  it('classifies a non-SDK Error carrying a permanent status', () => {
    expect(classifyError(new ForeignPermanentError('bad'))).toEqual<Classification>({
      retryable: false, reason: 'provider_rejected',
    })
  })

  it('does not read a status off a plain object that is not an Error', () => {
    // A bag of JSON with a `status` field is not evidence of an HTTP failure —
    // matching it would let any thrown payload masquerade as a provider error.
    expect(classifyError({ status: 503 })).toEqual<Classification>({
      retryable: false, reason: 'unclassified',
    })
  })

  it('ignores a non-numeric status', () => {
    const err = Object.assign(new Error('weird'), { status: 'down' })
    expect(classifyError(err)).toEqual<Classification>({
      retryable: false, reason: 'unclassified',
    })
  })
})

describe('classifyError — anything we do not recognise', () => {
  // Fail closed: an error we cannot name is NOT retried. Retrying what we do
  // not understand burns the turn's attempts and real money on every one of
  // them; refusing to retry costs at most one turn, which the user can resend.
  // It is recorded as `unclassified` rather than `provider_down` because we
  // have no evidence the provider is involved at all — worker.ts's own
  // `'park' is not implemented` throw lands here.
  const cases: ReadonlyArray<[string, unknown]> = [
    ['a bare Error', new Error('kiwi: HTTP 500')],
    ['a TypeError from our own code', new TypeError('x is not a function')],
    ['a string', 'something went wrong'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ]
  for (const [label, value] of cases) {
    it(`classifies ${label} as unclassified and non-retryable`, () => {
      expect(classifyError(value)).toEqual<Classification>({
        retryable: false, reason: 'unclassified',
      })
    })
  }
})

describe('isRefusal / throwIfRefused — the failure that returns HTTP 200', () => {
  const refusal = {
    stop_reason: 'refusal' as const,
    stop_details: { type: 'refusal' as const, category: 'cyber' as const, explanation: 'no' },
  }

  it('recognises stop_reason: refusal', () => {
    expect(isRefusal(refusal)).toBe(true)
  })

  // Every other member of the SDK's `StopReason` union, so the list is exhaustive
  // in fact and not merely in appearance.
  it.each([
    'end_turn', 'max_tokens', 'tool_use', 'pause_turn', 'stop_sequence',
    'model_context_window_exceeded',
  ] as const)(
    'does not treat stop_reason %s as a refusal', (stop_reason) => {
      expect(isRefusal({ stop_reason, stop_details: null })).toBe(false)
    })

  it('does not treat a null stop_reason (a stream still in flight) as a refusal', () => {
    expect(isRefusal({ stop_reason: null, stop_details: null })).toBe(false)
  })

  it('throws a RefusalError carrying the category', () => {
    expect(() => throwIfRefused(refusal)).toThrow(RefusalError)
    try {
      throwIfRefused(refusal)
      expect.unreachable('throwIfRefused must throw on a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(RefusalError)
      expect((err as RefusalError).category).toBe('cyber')
      expect((err as RefusalError).name).toBe('RefusalError')
    }
  })

  // stop_details is documented as populated for a refusal, but a refusal with
  // no details is still a refusal — the turn produced nothing either way.
  it('throws even when stop_details is missing, with a null category', () => {
    try {
      throwIfRefused({ stop_reason: 'refusal', stop_details: null })
      expect.unreachable('a refusal without details must still throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RefusalError)
      expect((err as RefusalError).category).toBeNull()
    }
  })

  it('returns quietly on a normal completion', () => {
    expect(() => throwIfRefused({ stop_reason: 'end_turn', stop_details: null })).not.toThrow()
  })
})
