import type { NextConfig } from 'next'
import { cspFor } from './web/csp'

// `NEXT_PUBLIC_SUPABASE_URL` is read at build/config-load time (not just in
// the browser) so the CSP's `connect-src` can be scoped to the real project
// host instead of a wildcard. `.env.local` (and Netlify's env in Task 10)
// carries the same value already used for `SUPABASE_URL`.
//
// `NEXT_PUBLIC_SUPABASE_ANON_KEY` isn't used by the CSP itself, but is
// guarded here too (fix round 1, Minor): both vars are required for the app
// to function at all (the browser client throws on the first Supabase call
// otherwise), and failing the build loudly beats shipping a build that only
// breaks once a user opens `/login`.
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!projectUrl || !anonKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are both required at build time',
  )
}

const csp = cspFor(projectUrl, { dev: process.env.NODE_ENV === 'development' })

const nextConfig: NextConfig = {
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into the repo root on every start.
  agentRules: false,
  // Plan 4a, Task 7. `src/` (and `web/session.ts`) write relative imports
  // with an explicit `.js` extension pointing at sibling `.ts` files —
  // correct, and required, under `tsconfig.harness.json`'s `NodeNext`
  // module resolution, which is what actually runs those files outside this
  // app (tsx scripts, the Netlify functions). Turbopack (Next 16's default
  // bundler) only maps `.js` → `.ts`/`.tsx` when the tsconfig it reads has
  // `moduleResolution: "nodenext"` — which the ROOT tsconfig.json
  // deliberately does NOT use (Task 6: `"bundler"`, specifically so `tsc
  // --noEmit` can resolve `next/server`'s subpath import, which NodeNext
  // resolution cannot — see that task's report). Flipping the root config to
  // `nodenext` to satisfy Turbopack would silently break `pnpm typecheck`'s
  // root pass again. Verified empirically (`next build`, `next build
  // --webpack`, and a `turbopack.resolveExtensions` override all tried
  // first): only building with webpack, with this `resolve.extensionAlias`,
  // resolves it — `package.json`'s `dev`/`build` scripts pass `--webpack`
  // for exactly this reason. `resolveExtensions` is left unset here
  // (Turbopack-only; irrelevant once webpack is what actually runs).
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts', '.tsx'],
    }
    return config
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ]
  },
}

export default nextConfig
