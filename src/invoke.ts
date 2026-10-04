/**
 * The one place a background turn is scheduled from. `submitMessage` and
 * `submitAction` (src/handler.ts) both call the function this returns as
 * their `invoke`, and the sweeper's re-invocation (`netlify/functions/
 * sweep.mts`) calls it for exactly the same reason it always did — a
 * requeued turn is scheduled the same way a brand-new one is. Keeping ONE
 * definition means a header, a path or a body shape changing is a single
 * edit, not three call sites that must be kept in sync by hand.
 *
 * Errors are swallowed here, not by the caller: every caller of the returned
 * function already treats a failed invocation as non-fatal (the turn is
 * durable at `queued`/re-`queued` before this is ever called, and the
 * sweeper is the backstop), so swallowing once, in the one place that knows
 * the fetch actually happened, is simpler than trusting three call sites to
 * each remember `.catch(() => {})`.
 */
export function invokeBackground(
  env: { SITE_URL: string; WORKER_SHARED_SECRET: string },
  fetchImpl: typeof fetch = fetch,
): (turnId: string) => Promise<void> {
  return async (turnId: string): Promise<void> => {
    // Best-effort by contract (the turn is durable at `queued` and the sweeper is the backstop),
    // but never silent: a refused or failed invoke is the one thing that explains a turn that
    // sits queued, so it is logged with the status and never the secret.
    try {
      const res = await fetchImpl(`${env.SITE_URL}/.netlify/functions/run-turn-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': env.WORKER_SHARED_SECRET },
        body: JSON.stringify({ turnId }),
      })
      if (res.status !== 202 && res.status !== 200) {
        console.error('invokeBackground: unexpected status', { turnId, status: res.status })
      }
    } catch (err) {
      console.error('invokeBackground: fetch failed', { turnId, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
