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

const csp = cspFor(projectUrl)

const nextConfig: NextConfig = {
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
