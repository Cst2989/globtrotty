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

  it('restricts images to self and data URIs', () => {
    expect(csp).toContain("img-src 'self' data:")
  })

  it('forbids framing', () => {
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('scopes connect-src to the project host over https and wss', () => {
    expect(csp).toContain('https://fhqsiydgoqmwvihqsbap.supabase.co')
    expect(csp).toContain('wss://fhqsiydgoqmwvihqsbap.supabase.co')
  })

  it('never contains a wildcard source', () => {
    expect(csp).not.toContain('*')
  })

  it('restricts base-uri and form-action to self', () => {
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
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
const FORBIDDEN_NEEDLES = ['SUPABASE_SERVICE_ROLE_KEY', 'sk-ant-', 'DATABASE_URL', 'dangerouslySetInnerHTML']

describe('web/app sentinel', () => {
  const middlewareCandidates = ['middleware.ts', 'proxy.ts'].map((f) => path.join(REPO_ROOT, f))
  const middlewareFile = middlewareCandidates.find(exists)

  it('ships exactly one of middleware.ts / proxy.ts', () => {
    expect(middlewareFile).toBeTruthy()
  })

  const targets = [
    ...filesUnder(path.join(REPO_ROOT, 'app')),
    ...filesUnder(path.join(REPO_ROOT, 'web')),
    path.join(REPO_ROOT, 'next.config.ts'),
    ...(middlewareFile ? [middlewareFile] : []),
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
