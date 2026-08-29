import type { Env } from './env.js'

/**
 * How tier 2 starts tier 3. This is the only place the shared secret is sent,
 * and it is the reason `WORKER_SHARED_SECRET` and `SITE_URL` are required keys.
 *
 * It throws when the platform itself refuses the call outright, because the
 * caller, `submitMessage`, already knows what to do with a failed invocation:
 * the turn is durable at 'queued', so the failure is logged and she still gets
 * an answer. `run-turn-background.mts` answers 202 before it ever reads the
 * secret, so a wrong secret is never one of the rejections this function can
 * see; that check is proven inside the function itself and in its own tests.
 */
export function httpInvoke(env: Env): (turnId: string) => Promise<void> {
  return async (turnId) => {
    const res = await fetch(`${env.SITE_URL}/.netlify/functions/run-turn-background`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': env.WORKER_SHARED_SECRET,
      },
      body: JSON.stringify({ turnId }),
    })
    if (!res.ok) throw new Error(`tier 3 refused turn ${turnId}: ${res.status}`)
  }
}
