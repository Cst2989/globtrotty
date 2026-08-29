import { vi } from 'vitest'
import type { Env } from '../src/env.js'
import { httpInvoke } from '../src/invoke.js'
import { authorize } from '../src/tier3.js'

const env: Env = {
  DATABASE_URL: 'postgres://localhost/course',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  WORKER_SHARED_SECRET: 'a-shared-secret-value',
  SITE_URL: 'http://localhost:8888',
}

type SentRequest = { method: string; headers: Record<string, string>; body: string }

function stubFetch(status = 200) {
  const mock = vi.fn().mockResolvedValue(new Response('ok', { status }))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('httpInvoke', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts the turn id to the background function with the shared secret', async () => {
    const fetchMock = stubFetch()
    await httpInvoke(env)('turn-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, SentRequest]
    expect(url).toBe('http://localhost:8888/.netlify/functions/run-turn-background')
    expect(init.method).toBe('POST')
    expect(init.headers['x-worker-secret']).toBe('a-shared-secret-value')
    expect(JSON.parse(init.body)).toEqual({ turnId: 'turn-1' })
  })

  // The two halves meet here, but only in-process: what this sends is exactly
  // what authorize accepts, and the same body with no header is something
  // authorize itself rejects. Over real HTTP, `run-turn-background.mts` is a
  // background function, and Netlify answers 202 the instant the function is
  // triggered, before authorize has run inside it, so this pairing is what
  // proves the secret check is correct, not a claim about what an HTTP caller
  // would see back.
  it('builds a request authorize accepts, and rejects the same body with no header', async () => {
    const fetchMock = stubFetch()
    await httpInvoke(env)('turn-1')
    const [, init] = fetchMock.mock.calls[0] as [string, SentRequest]
    const body: unknown = JSON.parse(init.body)
    expect(authorize({ secret: init.headers['x-worker-secret']!, body }, env.WORKER_SHARED_SECRET))
      .toEqual({ kind: 'run', turnId: 'turn-1' })
    expect(authorize({ secret: null, body }, env.WORKER_SHARED_SECRET))
      .toEqual({ kind: 'reject', status: 401, body: 'unauthorized' })
  })

  // Not a stand-in for a wrong secret: a background function's own 202 means
  // httpInvoke never sees the 401 authorize would answer, on a wrong secret or
  // any other. This is the platform itself refusing the call outright (the
  // function missing, Netlify down), which is the only rejection httpInvoke's
  // caller can ever observe.
  it('throws when the platform itself refuses the call, so the caller can log it', async () => {
    stubFetch(404)
    await expect(httpInvoke(env)('turn-1')).rejects.toThrow('404')
  })
})
