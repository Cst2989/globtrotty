// Plan 4a, Task 6. Pure-helper + file-content checks only — no DB, no Next
// runtime. `cspFor` lives in `web/csp.ts` specifically so this file can
// import it directly instead of loading `next.config.ts` (which throws at
// import time if `NEXT_PUBLIC_SUPABASE_URL` is unset, and pulls in Next's own
// config-loading machinery this test has no need of).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cspFor } from '../web/csp.js'

const REPO_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Every file under `dir`, recursively (order not significant). */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

function exists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}

describe('cspFor', () => {
  const csp = cspFor('https://fhqsiydgoqmwvihqsbap.supabase.co')

  it('restricts images to self, data URIs and the Kiwi logo host', () => {
    expect(csp).toContain(
      "img-src 'self' data: https://images.kiwi.com https://lh3.googleusercontent.com"
      + ' https://*.gstatic.com https://server.arcgisonline.com')
  })

  it('forbids framing', () => {
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('scopes connect-src to the project host over https and wss', () => {
    expect(csp).toContain('https://fhqsiydgoqmwvihqsbap.supabase.co')
    expect(csp).toContain('wss://fhqsiydgoqmwvihqsbap.supabase.co')
  })

  it('carries one wildcard source, and it is subdomain-only', () => {
    // The hotels pass widened `img-src` with Google's two image hosts. Google numbers the
    // thumbnail ones (`encrypted-tbn0`, `encrypted-tbn1`, ...) so there is no single name to
    // pin; everything else here is an exact host, the tile server included.
    // `test/web-csp.test.ts` pins the whole directive character for character.
    expect(csp.match(/\*/g)).toHaveLength(1)
    expect(csp).toContain('https://*.gstatic.com')
    expect(csp).toContain('https://server.arcgisonline.com')
  })

  it('restricts base-uri and form-action to self', () => {
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })

  it('sets a self-only default-src', () => {
    expect(csp).toContain("default-src 'self'")
  })
})

// Fix round 1 (Minor): `next.config.ts` can't be imported here (it throws
// without `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` and pulls in Next's config
// loader — see the header above), so this checks its *source text* for the
// three headers `headers()` is supposed to set, instead of the built config
// object.
describe('next.config.ts', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'next.config.ts'), 'utf8')

  it('sets Content-Security-Policy, Referrer-Policy, and X-Content-Type-Options', () => {
    expect(source).toContain('Content-Security-Policy')
    expect(source).toContain('Referrer-Policy')
    expect(source).toContain('X-Content-Type-Options')
  })
})

describe('tsconfig split (Deviation 2)', () => {
  const harness = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tsconfig.harness.json'), 'utf8')) as {
    include: string[]
  }
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8')) as {
    include?: string[]
  }

  it('tsconfig.harness.json includes src, test, and netlify', () => {
    expect(harness.include).toEqual(expect.arrayContaining(['src', 'test', 'netlify']))
  })

  it('tsconfig.json (Next’s config) does not include test', () => {
    expect(root.include ?? []).not.toContain('test')
  })
})

const ALLOWED_NEXT_PUBLIC = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])
// Fix round 1 (Important): 'JEV_KEY' added. It is harness-only — read via
// `loadOptionalEnv` (src/env.ts) in server-side code, never shipped to the
// browser — so its name must never appear under app/ or web/, same as the
// other credential needles below.
const FORBIDDEN_NEEDLES = ['SUPABASE_SERVICE_ROLE_KEY', 'sk-ant-', 'DATABASE_URL', 'dangerouslySetInnerHTML', 'JEV_KEY']

describe('web/app sentinel', () => {
  // Fix round 1 (Minor): `.filter()` + `toHaveLength(1)` rather than
  // `.find()` + truthy — this fails loudly if a stray copy of the OTHER
  // convention's file ever gets committed alongside the one in use (e.g. a
  // future rename that forgets to `git rm` the old file), instead of
  // silently picking whichever `.find()` happens to see first.
  const middlewareCandidates = ['middleware.ts', 'proxy.ts'].map((f) => path.join(REPO_ROOT, f))
  const middlewareFiles = middlewareCandidates.filter(exists)

  it('ships exactly one of middleware.ts / proxy.ts', () => {
    expect(middlewareFiles).toHaveLength(1)
  })

  const targets = [
    ...filesUnder(path.join(REPO_ROOT, 'app')),
    ...filesUnder(path.join(REPO_ROOT, 'web')),
    path.join(REPO_ROOT, 'next.config.ts'),
    ...middlewareFiles,
  ]

  it('scans at least the expected app/ and web/ files', () => {
    // Guards against the walk silently finding nothing (e.g. a renamed dir)
    // and the two checks below passing vacuously.
    expect(targets.length).toBeGreaterThan(5)
  })

  it('never references a forbidden secret name, key prefix, or dangerous prop', () => {
    const offenders: string[] = []
    for (const file of targets) {
      const text = readFileSync(file, 'utf8')
      for (const needle of FORBIDDEN_NEEDLES) {
        if (text.includes(needle)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never declares a NEXT_PUBLIC_ name beyond the two allowed', () => {
    const offenders: string[] = []
    for (const file of targets) {
      const text = readFileSync(file, 'utf8')
      const matches = text.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? []
      for (const name of matches) {
        if (!ALLOWED_NEXT_PUBLIC.has(name)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${name}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('.env.example', () => {
  const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8')

  it('lists both NEXT_PUBLIC_ names with no value', () => {
    expect(example).toMatch(/^NEXT_PUBLIC_SUPABASE_URL=\s*$/m)
    expect(example).toMatch(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=\s*$/m)
  })
})
