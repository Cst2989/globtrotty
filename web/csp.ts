// Plan 4a, Task 6: a small, Next-free module so `test/web-config.test.ts` can
// assert on the Content-Security-Policy string without loading `next.config.ts`
// (which touches Next's config-loading machinery and process.env at import
// time). `next.config.ts` imports this same helper for `headers()`.
//
// `img-src` carries three third-party image origins and `blob:`:
//
//  - `https://images.kiwi.com` — the airline logos on a flight card (results
//    UI pass 2, C). Self-hosting ~1000 carrier logos was the alternative; it
//    trades a 24-hour-stale logo for a megabyte of binaries in the repo and a
//    build step that has to notice a rebrand.
//  - `https://lh3.googleusercontent.com` and `https://*.gstatic.com` — the
//    hotel photographs (hotels pass, section 3). These are exactly the hosts
//    `allowedImageUrl` (src/supplier/searchapi.ts) admits at the adapter
//    boundary and `web/data.ts` re-checks on the way out of the corpus; this
//    directive is the browser's own backstop behind both.
//  - `blob:` — MapLibre decodes the sprite sheet and the natural-earth raster
//    into blobs before it uploads them to the GPU (trip-stage pass, section 5).
//
// Each is an IMAGE origin only, which can neither run script nor read anything
// out of this document. The two subdomain wildcards are unavoidable: Google
// serves its thumbnails from numbered hosts (`encrypted-tbn0`,
// `encrypted-tbn1`, ...), with no stable single name to pin.
//
// `connect-src` admits `https://tiles.openfreemap.org` and nothing else new:
// the whole basemap — the style document, the vector tiles, the sprites and
// the glyphs — comes from that one exact origin, with no key and no wildcard.
// The three RASTER services that came before it are gone with Leaflet: OSM's
// own servers 403 an anonymous deployment, CARTO's CDN answers 200 with a tile
// reading "API KEY REQUIRED", and Esri's Dark Gray Canvas (which did work)
// could not be asked for English labels. MapLibre itself is bundled from
// node_modules, so nothing but the map's own data leaves this origin.
//
// `worker-src blob:` and `child-src blob:` are what MapLibre's tile workers
// need: it compiles its worker from a blob URL, and without both directives
// the map renders a blank canvas and says so only in the console. `child-src`
// is the fallback older engines read when they do not know `worker-src`.
//
// `'unsafe-inline'` on `script-src` is a deliberate, recorded compromise, not
// an oversight: Next's nonce-based strict CSP needs a middleware nonce wired
// through `next.config.ts` and verified against the Netlify runtime's output,
// which the plan explicitly time-boxes (fifteen minutes) and defers to the
// Task 11 backlog rather than have Task 6 chase it. Revisit there.
export function cspFor(projectUrl: string, options: { dev?: boolean } = {}): string {
  const { host } = new URL(projectUrl)

  /*
   * `next dev --webpack` serves its modules through `eval`, so without this the DEV server
   * answers every page with a CSP that stops its own bundle executing: the app never hydrates,
   * nothing on it works, and the only sign is one console line. The browser harness
   * (test/e2e/trip.e2e.mjs) found it on its first real run, which is the whole argument for
   * having a browser harness.
   *
   * `dev` is false by default and `next.config.ts` passes `process.env.NODE_ENV !==
   * 'production'`, so a production build can never take this branch — and `test/web-csp.test.ts`
   * pins that the production string carries no `unsafe-eval` at all.
   */
  const scriptSrc = options.dev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'"

  const directives = [
    "default-src 'self'",
    'img-src \'self\' data: blob: https://images.kiwi.com https://lh3.googleusercontent.com'
      + ' https://*.gstatic.com',
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    `connect-src 'self' https://${host} wss://${host} https://tiles.openfreemap.org`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]

  return directives.join('; ')
}
