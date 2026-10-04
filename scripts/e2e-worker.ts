/**
 * Trip-stage pass, section 6: the background worker, locally, for the browser harness.
 *
 * `invokeBackground` (src/invoke.ts) POSTs every queued turn to
 * `${SITE_URL}/.netlify/functions/run-turn-background` and swallows the result, because the turn
 * is already durable and the sweeper is the backstop. `.env.local` points `SITE_URL` at
 * `localhost:8888` — the port `netlify dev` would serve — so with nothing listening there every
 * POST failed silently and the harness's turns were being picked up MINUTES later by whichever
 * sweeper happened to run. That is why the office looked slow, and it is also why no change to
 * `src/` could ever be exercised by the harness: the turn was executing somewhere else.
 *
 * So this serves the one route, in this process, out of this worktree's own code. It is the same
 * handler the deployed function is (`netlify/functions/run-turn-background.mts`, imported rather
 * than copied), given a Fetch `Request` and asked for a `Response`, which is exactly the contract
 * Netlify Functions v2 give it.
 *
 * LOCAL ONLY, started and stopped by `scripts/e2e.sh`. It binds to loopback and refuses any
 * request without the same `WORKER_SHARED_SECRET` the deployed function checks, because it is
 * the same code doing the checking.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const { default: handler } = await import('../netlify/functions/run-turn-background.mts')

const PORT = Number(process.env.E2E_WORKER_PORT ?? 8888)
const ROUTE = '/.netlify/functions/run-turn-background'

/** The node request as the Fetch `Request` a v2 function is handed. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
  }
  return new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  })
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.url !== ROUTE) {
      res.writeHead(404).end('not found')
      return
    }
    try {
      const response = await handler(await toRequest(req))
      res.writeHead(response.status).end(await response.text())
    } catch (err) {
      // A thrown turn is a real failure and the harness should see it in this log rather than
      // as a conversation that silently never finishes.
      console.error('e2e-worker: the turn threw', err)
      res.writeHead(500).end('error')
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`e2e-worker listening on 127.0.0.1:${PORT}${ROUTE}`)
})
