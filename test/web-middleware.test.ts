// Fix round 1 (plan 4a, Task 6 review, Important): `decide()` is the pure
// core of `updateSession` — no `NextRequest`, no Supabase call — so its three
// outcomes (let through, redirect to /login, 401) are tested directly rather
// than through the full middleware.
//
// This file is listed in tsconfig.harness.json's `exclude` for the same
// reason as test/web-session.test.ts's header comment: importing
// web/supabase/middleware.ts pulls in 'next/server', which the harness's
// NodeNext resolution can't resolve a subpath from. The source file is still
// type-checked (cleanly) by the Next/bundler-resolution `tsc --noEmit` pass;
// this file's behavior is verified by running it, under `pnpm test`.
import { describe, expect, it } from 'vitest'
import { decide } from '../web/supabase/middleware.js'

describe('decide', () => {
  it('lets an authenticated request through on any path', () => {
    expect(decide('/', true)).toBe('next')
    expect(decide('/c/new', true)).toBe('next')
    expect(decide('/api/turns', true)).toBe('next')
  })

  it('lets an unauthenticated request through on the public paths', () => {
    expect(decide('/login', false)).toBe('next')
    expect(decide('/auth/callback', false)).toBe('next')
  })

  it('lets Netlify function paths through without a session (worker secret auths them)', () => {
    // Deploy smoke (plan 4a, Task 10): the default matcher 307'd the
    // background worker to /login, so no turn could start.
    expect(decide('/.netlify/functions/run-turn-background', false)).toBe('next')
    expect(decide('/.netlify/functions/sweep', false)).toBe('next')
  })

  it('responds 401 for an unauthenticated API route', () => {
    expect(decide('/api/turns', false)).toBe('401')
  })

  it('redirects an unauthenticated request on any other path', () => {
    expect(decide('/', false)).toBe('redirect')
    expect(decide('/c/new', false)).toBe('redirect')
  })
})
