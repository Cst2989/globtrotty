// Fix round 1 (plan 4a, Task 6 review, Critical): `requireUser()` used to
// throw a `NextResponse` directly, which Next's own error boundary turns
// into a 500 for any uncaught throw — verified against the installed Next 16
// runtime, not assumed. `requireUser()` now throws `UnauthorizedError`, a
// real `Error`; `withUser` is the one place that converts it into the actual
// 401 JSON response. These tests cover both halves of that contract.
//
// This file is listed in tsconfig.harness.json's `exclude`: it imports
// web/session.ts, which imports 'next/server' — a package with no "exports"
// field in its package.json, which the harness's NodeNext module resolution
// (pinned TypeScript 7, a preview compiler) cannot resolve a subpath import
// from (confirmed with `tsc --traceResolution`). `web/session.ts` itself is
// still type-checked, cleanly, by `tsc --noEmit`'s Next/bundler-resolution
// pass (the second half of `pnpm typecheck`); this file's own behavior is
// still verified, by running (this is `pnpm test`, not `pnpm typecheck`).
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock`'s factory (and this `vi.hoisted` block) are hoisted above every
// import in this file, including the static import of `web/session.js`
// below — so by the time that import's own `./supabase/server.js` import
// resolves, it resolves to this mock, not the real module (which would try
// to call `next/headers`' `cookies()` outside a request context).
const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }))

vi.mock('../web/supabase/server.js', () => ({
  createServerSupabase: vi.fn(async () => ({ auth: { getUser } })),
}))

import { requireUser, withUser, UnauthorizedError } from '../web/session.js'

describe('requireUser', () => {
  beforeEach(() => {
    getUser.mockReset()
  })

  it('throws UnauthorizedError (a real Error, not a Response) when there is no user', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(requireUser()).rejects.toBeInstanceOf(Error)
  })

  it('resolves { id, email } when a user is present', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } })
    await expect(requireUser()).resolves.toEqual({ id: 'u1', email: 'a@b.com' })
  })

  it('falls back email to null when Supabase omits it', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: undefined } } })
    await expect(requireUser()).resolves.toEqual({ id: 'u1', email: null })
  })
})

describe('withUser', () => {
  beforeEach(() => {
    getUser.mockReset()
  })

  it('returns a 401 JSON response and never calls fn when there is no user', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const fn = vi.fn()
    const handler = withUser(fn)

    const res = await handler(new Request('http://x.test/'), { params: Promise.resolve({}) })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('passes { id, email } to fn and returns its Response when a user exists', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } })
    const inner = new Response('ok')
    const fn = vi.fn(async () => inner)
    const handler = withUser(fn)
    const req = new Request('http://x.test/')
    const ctx = { params: Promise.resolve({}) }

    const res = await handler(req, ctx)

    expect(res).toBe(inner)
    expect(fn).toHaveBeenCalledWith({ id: 'u1', email: 'a@b.com' }, req, ctx)
  })

  it('rethrows any error other than UnauthorizedError', async () => {
    getUser.mockRejectedValue(new Error('db down'))
    const fn = vi.fn()
    const handler = withUser(fn)

    await expect(
      handler(new Request('http://x.test/'), { params: Promise.resolve({}) }),
    ).rejects.toThrow('db down')
    expect(fn).not.toHaveBeenCalled()
  })
})
