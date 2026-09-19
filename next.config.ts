import type { NextConfig } from 'next'
import { cspFor } from './web/csp'

// `NEXT_PUBLIC_SUPABASE_URL` is read at build/config-load time (not just in
// the browser) so the CSP's `connect-src` can be scoped to the real project
// host instead of a wildcard. `.env.local` (and Netlify's env in Task 10)
// carries the same value already used for `SUPABASE_URL`.
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
if (!projectUrl) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL is required at build time to scope the Content-Security-Policy header',
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
