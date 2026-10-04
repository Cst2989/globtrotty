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
//  - `https://*.basemaps.cartocdn.com` — the map tiles (hotels pass, section
//    5). OSM's own tile servers answer this deployment with a 403 and an
//    "Access blocked" tile: their usage policy wants a named, contactable
//    application, so the tiles come from CARTO's basemap CDN, which serves
//    them from `a.` through `d.` — a subdomain wildcard for the same reason
//    gstatic's is. Leaflet itself is bundled from node_modules, so nothing but
//    the tiles leaves this origin.
//  - `https://lh3.googleusercontent.com` and `https://*.gstatic.com` — the
//    hotel photographs (hotels pass, section 3). These are exactly the hosts
//    `allowedImageUrl` (src/supplier/searchapi.ts) admits at the adapter
//    boundary and `web/data.ts` re-checks on the way out of the corpus; this
//    directive is the browser's own backstop behind both.
//
// Each is an IMAGE origin only, which can neither run script nor read anything
// out of this document. The two subdomain wildcards are unavoidable: Google
// serves its thumbnails from numbered hosts (`encrypted-tbn0`,
// `encrypted-tbn1`, ...) and CARTO serves tiles from `a` through `d`, with no
// stable single name to pin in either case.
//
// `'unsafe-inline'` on `script-src` is a deliberate, recorded compromise, not
// an oversight: Next's nonce-based strict CSP needs a middleware nonce wired
// through `next.config.ts` and verified against the Netlify runtime's output,
// which the plan explicitly time-boxes (fifteen minutes) and defers to the
// Task 11 backlog rather than have Task 6 chase it. Revisit there.
export function cspFor(projectUrl: string): string {
  const { host } = new URL(projectUrl)

  const directives = [
    "default-src 'self'",
    'img-src \'self\' data: https://images.kiwi.com https://lh3.googleusercontent.com'
      + ' https://*.gstatic.com https://*.basemaps.cartocdn.com',
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self' https://${host} wss://${host}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]

  return directives.join('; ')
}
