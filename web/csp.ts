// Plan 4a, Task 6: a small, Next-free module so `test/web-config.test.ts` can
// assert on the Content-Security-Policy string without loading `next.config.ts`
// (which touches Next's config-loading machinery and process.env at import
// time). `next.config.ts` imports this same helper for `headers()`.
//
// `img-src` carries three third-party image origins and nothing else:
//
//  - `https://images.kiwi.com` — the airline logos on a flight card (results
//    UI pass 2, C). Self-hosting ~1000 carrier logos was the alternative; it
//    trades a 24-hour-stale logo for a megabyte of binaries in the repo and a
//    build step that has to notice a rebrand.
//  - `https://server.arcgisonline.com` — the map tiles (hotels pass, section
//    5). An EXACT origin, no wildcard: Esri serves its Dark Gray Canvas from
//    one host and needs no key. Two basemaps failed before it — OSM's own
//    servers 403 an anonymous deployment, and CARTO's CDN answers 200 with a
//    tile reading "API KEY REQUIRED" — so this directive has been wrong twice
//    in a way only a screenshot could catch. Leaflet itself is bundled from
//    node_modules, so nothing but the tiles leaves this origin.
//  - `https://lh3.googleusercontent.com` and `https://*.gstatic.com` — the
//    hotel photographs (hotels pass, section 3). These are exactly the hosts
//    `allowedImageUrl` (src/supplier/searchapi.ts) admits at the adapter
//    boundary and `web/data.ts` re-checks on the way out of the corpus; this
//    directive is the browser's own backstop behind both.
//
// Each is an IMAGE origin only, which can neither run script nor read anything
// out of this document. The two subdomain wildcards are unavoidable: Google
// serves its thumbnails from numbered hosts (`encrypted-tbn0`,
// `encrypted-tbn1`, ...), with no stable single name to pin. The tile host is
// not one of them: it is exact.
//
// `'unsafe-inline'` on `script-src` is a deliberate, recorded compromise, not
// an oversight: Next's nonce-based strict CSP needs a middleware nonce wired
// through `next.config.ts` and verified against the Netlify runtime's output,
// which the plan explicitly time-boxes (fifteen minutes) and defers to the
// Task 11 backlog rather than have Task 6 chase it. Revisit there.
/**
 * `dev` (next dev only, never production): webpack's HMR runtime evaluates code and talks over a
 * local websocket, which the production policy rightly forbids. Production builds pass `false`.
 */
export function cspFor(projectUrl: string, opts: { dev?: boolean } = {}): string {
  const { host } = new URL(projectUrl)
  const dev = opts.dev === true

  const directives = [
    "default-src 'self'",
    'img-src \'self\' data: https://images.kiwi.com https://lh3.googleusercontent.com'
      + ' https://*.gstatic.com https://server.arcgisonline.com',
    "style-src 'self' 'unsafe-inline'",
    dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
    dev
      ? `connect-src 'self' https://${host} wss://${host} ws://localhost:* http://localhost:*`
      : `connect-src 'self' https://${host} wss://${host}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]

  return directives.join('; ')
}
