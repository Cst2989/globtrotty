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
  it('is exactly self, data:, blob: and the three image hosts this product renders', () => {
    const directives = cspFor(PROJECT_URL).split('; ')
    const imgSrc = directives.find((d) => d.startsWith('img-src '))
    expect(imgSrc).toBe(
      "img-src 'self' data: blob: https://images.kiwi.com https://lh3.googleusercontent.com"
      + ' https://*.gstatic.com')
  })

  it('names each host, never a scheme-wide source, and wildcards only one subdomain', () => {
    const imgSrc = cspFor(PROJECT_URL).split('; ').find((d) => d.startsWith('img-src '))!
    expect(imgSrc).not.toMatch(/https:(\s|$)/)
    // ONE subdomain wildcard, and it is unavoidable: Google numbers its thumbnail hosts
    // (`encrypted-tbn0`, ...) with no stable single name to pin.
    expect(imgSrc.match(/\*/g)).toHaveLength(1)
    expect(imgSrc).toContain('https://*.gstatic.com')
    // The three raster tile services went with Leaflet (trip-stage pass, section 5).
    expect(cspFor(PROJECT_URL)).not.toContain('arcgisonline')
    expect(cspFor(PROJECT_URL)).not.toContain('cartocdn')
    expect(cspFor(PROJECT_URL)).not.toContain('tile.openstreetmap.org')
  })

  /*
   * Trip-stage pass, section 5. MapLibre fetches the whole basemap — the style document, the
   * vector tiles, the sprites and the glyphs — from ONE exact origin, and compiles its tile
   * workers from a blob URL. Without both blob directives the map renders a blank canvas and
   * says so only in the console, which is the failure mode this project has now hit three times.
   */
  it('admits the one tile origin and the blobs MapLibre\'s workers need, and nothing else', () => {
    const directives = cspFor(PROJECT_URL).split('; ')
    const connect = directives.find((d) => d.startsWith('connect-src '))!
    expect(connect).toContain('https://tiles.openfreemap.org')
    expect(connect).not.toContain('*')
    expect(directives).toContain("worker-src 'self' blob:")
    expect(directives).toContain("child-src 'self' blob:")
  })

  it('does NOT widen script-src or style-src for the map: MapLibre is bundled', () => {
    const directives = cspFor(PROJECT_URL).split('; ')
    expect(directives).toContain("style-src 'self' 'unsafe-inline'")
    expect(directives).toContain("script-src 'self' 'unsafe-inline'")
    // `unsafe-eval` is a DEV-only widening (the webpack dev server evaluates its own modules;
    // see `cspFor`). A production policy must never carry it, whatever `next.config.ts` passes.
    expect(cspFor(PROJECT_URL)).not.toContain('unsafe-eval')
    expect(cspFor(PROJECT_URL, { dev: false })).not.toContain('unsafe-eval')
    expect(cspFor(PROJECT_URL, { dev: true })).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    // The CDN host the tiles come from is an IMAGE origin and nothing else. This used to read
    // `not.toContain('cdn')` over the whole policy, which only worked while no third-party
    // origin happened to have "cdn" in its name; the claim it was making all along is this one.
    for (const name of ['style-src', 'script-src', 'default-src']) {
      const directive = directives.find((d) => d.startsWith(`${name} `))!
      expect(directive).not.toContain('cdn')
      expect(directive).not.toContain('unpkg')
    }
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
    // The `dev` flag follows `NODE_ENV`, exactly as `next.config.ts` passes it; under vitest
    // that is `test`, which is not `production`, so the dev widening applies here too.
    expect(csp).toBe(cspFor(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      { dev: process.env.NODE_ENV !== 'production' },
    ))
    expect(csp!.split('; ')).toContain(
      "img-src 'self' data: blob: https://images.kiwi.com https://lh3.googleusercontent.com"
      + ' https://*.gstatic.com')
  })
})
