import { APIError } from '@anthropic-ai/sdk/core/error'

/**
 * A real SDK error of a given status, which is what `classifyError`
 * (src/errors.ts) and `withRetry` (src/retry.ts) branch on. Built through
 * `APIError.generate` rather than by hand, so the status-to-subclass mapping is
 * the SDK's own and a test cannot accidentally assert against a shape the SDK
 * never produces.
 */
export const apiError = (status: number, headers = new Headers()): unknown =>
  APIError.generate(status, { type: 'error', error: { type: 'api_error', message: 'boom' } }, undefined, headers)
