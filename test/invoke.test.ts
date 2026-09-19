import { describe, it, expect, vi } from 'vitest'
import { invokeBackground } from '../src/invoke.js'

const ENV = { SITE_URL: 'https://example.test', WORKER_SHARED_SECRET: 'shh' }

describe('invokeBackground', () => {
  it('POSTs the turn id, url and shared-secret header to run-turn-background', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'))
    await invokeBackground(ENV, fetchImpl)('turn-123')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.test/.netlify/functions/run-turn-background')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': 'shh' },
    })
    expect(JSON.parse(init.body as string)).toEqual({ turnId: 'turn-123' })
  })

  it('does not throw when the fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(invokeBackground(ENV, fetchImpl)('turn-123')).resolves.toBeUndefined()
  })
})
