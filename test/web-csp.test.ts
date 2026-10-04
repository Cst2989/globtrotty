// Plan 4a, Task 9. `test/web-config.test.ts` already `toContain`s a handful
// of CSP directives against `cspFor`'s output and grep's `next.config.ts`'s
// source text for the three header NAMES it sets (it can't import
// `next.config.ts` there — see that file's own header comment on why). This
// file is the PIN the brief asks for on top of that: it imports
// `next.config.ts` for real (this file matches `test/web-*.test.ts`, the one
// glob `tsconfig.webtests.json` includes and `tsconfig.harness.json`
// excludes — the split `test/web-config.test.ts` documents — so `next`'s own
// bundler-resolution tsconfig, not NodeNext, is what typechecks the import
// below) and calls the real `headers()` function Next actually invokes, then
// asserts on the EXACT `img-src` directive and the exact route the CSP
// header applies to, not merely that some substring is present somewhere in
// the string. A future edit that widens `img-src` to `'self' data: https:`
// (still `toContain`s `"'self' data:"`) would slip past a substring check
// but fails the equality assertion here — which is the whole point now that
// the directive carries a third-party host at all (the Kiwi logo CDN).
import { describe, expect, it } from 'vitest'
import { cspFor } from '../web/csp.js'

const PROJECT_URL = 'https://fhqsiydgoqmwvihqsbap.supabase.co'

describe('cspFor: img-src is pinned exactly', () => {
  it('is exactly self, data:, the Kiwi logo host and Google\'s two image hosts, nothing wider', () => {
    const directives = cspFor(PROJECT_URL).split('; ')
    const imgSrc = directives.find((d) => d.startsWith('img-src '))
    expect(imgSrc).toBe(
      "img-src 'self' data: https://images.kiwi.com https://lh3.googleusercontent.com"
      + ' https://*.gstatic.com')
  })

  it('names each host, never a scheme-wide source, and wildcards only gstatic\'s subdomain', () => {
    const imgSrc = cspFor(PROJECT_URL).split('; ').find((d) => d.startsWith('img-src '))!
    expect(imgSrc).not.toMatch(/https:(\s|$)/)
    // The hotels pass's one wildcard, and it is a SUBDOMAIN wildcard on a single registrable
    // domain — Google numbers these thumbnail hosts (`encrypted-tbn0`, `encrypted-tbn1`, ...)
    // and there is no stable single name to pin. Nothing else in the directive carries one.
    expect(imgSrc.match(/\*/g)).toHaveLength(1)
    expect(imgSrc).toContain('https://*.gstatic.com')
  })
})

describe('next.config.ts headers(): the real config object', () => {
  it('applies the CSP (and the other two security headers) to every path', async () => {
    // `next.config.ts` throws at import time without these two — set by
    // `test/setup.ts`'s `dotenv` load of `.env.local`, same as the app's own
    // build/runtime. Asserted here so a missing `.env.local` fails with a
    // clear message instead of an opaque import-time throw below.
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBeTruthy()
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeTruthy()

    const { default: nextConfig } = await import('../next.config.js')
    const rules = await nextConfig.headers!()
    expect(rules).toHaveLength(1)
    const [rule] = rules
    // Next's own path-matching syntax for "every path" — equivalent to the
    // brief's `/(.*)`, spelled the way `next.config.ts` actually spells it.
    expect(rule!.source).toBe('/:path*')

    const byKey = new Map(rule!.headers.map((h) => [h.key, h.value]))
    expect(byKey.get('Referrer-Policy')).toBe('no-referrer')
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff')

    const csp = byKey.get('Content-Security-Policy')
    expect(csp).toBeTruthy()
    // The exact same string `cspFor` builds from the real project URL this
    // process is configured with — proves `next.config.ts` wires its own
    // `headers()` to `cspFor`, not a copy that has since drifted from it.
    expect(csp).toBe(cspFor(process.env.NEXT_PUBLIC_SUPABASE_URL!))
    expect(csp!.split('; ')).toContain(
      "img-src 'self' data: https://images.kiwi.com https://lh3.googleusercontent.com"
      + ' https://*.gstatic.com')
  })
})
