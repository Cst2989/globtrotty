import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type Sentinel = { name: string; pattern: RegExp; why: string }

/**
 * Strings that must never appear in anything we deploy.
 *
 * The article this course is built from greps a compiled client bundle for the
 * reviewer prompt, after a single helper import pulled the prompt file into it.
 * That leak is real and it is a defect of a build this repository does not have:
 * there is no bundler here, no build step, and nothing that concatenates a
 * server module into something a browser downloads. Greping a bundle that does
 * not exist would be a test that passes because it found nothing to look at,
 * which is the worst kind.
 *
 * So the grep runs over what this repository actually deploys: `src/` and
 * `netlify/`, which Netlify uploads, and `public/`, which is served verbatim.
 * The prompt sentinels are still checked, because a helper that inlines a desk
 * prompt into a response body is the same mistake without a bundler, and the
 * secret patterns are the ones SPEC section 10 names and that this repository
 * can genuinely commit today.
 */
export const SENTINELS: readonly Sentinel[] = [
  {
    name: 'service-role-key',
    pattern: /SUPABASE_SERVICE_ROLE_KEY/,
    why: 'The service role key bypasses every policy. It belongs in the worker environment and '
      + 'in nothing that is served or bundled.',
  },
  {
    name: 'anthropic-key',
    pattern: /sk-ant-[A-Za-z0-9_-]{8,}/,
    why: 'A literal API key. Committed once, it is spent by somebody else before it is rotated.',
  },
  {
    name: 'public-secret',
    pattern: /NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)/,
    why: 'A NEXT_PUBLIC_ variable is shipped to the browser by definition, so one carrying a '
      + 'secret is a secret with a label saying it is not one.',
  },
  {
    name: 'front-desk-prompt',
    pattern: /GLOBETROTTY-FRONT-DESK-PROMPT-DO-NOT-SHIP/,
    why: 'The front desk prompt reached something we deploy. A prompt is the product; it is read '
      + 'from src/desks at run time and is never inlined anywhere.',
  },
  {
    name: 'planning-desk-prompt',
    pattern: /GLOBETROTTY-PLANNING-DESK-PROMPT-DO-NOT-SHIP/,
    why: 'The planning desk prompt reached something we deploy, as above.',
  },
  {
    name: 'scout-prompt',
    pattern: /GLOBETROTTY-SCOUT-PROMPT-DO-NOT-SHIP/,
    why: 'The scout prompt reached something we deploy. It is read from '
      + 'src/agents/prompts at run time, through the same comment-stripping loader the desks '
      + 'use, and is never inlined anywhere.',
  },
]

export type Finding = { file: string; line: number; sentinel: string; excerpt: string }

/**
 * The files that legitimately hold the sentinels: the prompts themselves, which
 * are the source of truth, and this file, which names the patterns.
 * Everything else is a finding. Listed by suffix, and matched against the
 * RESOLVED path, so the check works whether it was handed `src` or an absolute
 * root and from whatever working directory it was started in.
 */
const ALLOWED = ['/src/desks/front-desk.md', '/src/desks/planning-desk.md',
                 '/src/agents/prompts/scout.md', '/scripts/sentinels.ts']

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist'])

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(full)
    return [full]
  })
}

/**
 * The file's lines, or null when it is not there any more.
 *
 * `walk` lists every path first and this reads them afterwards, so anything that
 * removes a file inside that window arrives here as an ENOENT. That window is
 * real and not theoretical: `test/desks.test.ts` writes src/desks/stray-desk.md
 * and removes it in a `finally`, and vitest runs test files in parallel by
 * default, so the check can be handed a path that existed a microsecond ago.
 * A file that is gone cannot be leaking anything, and failing the whole check
 * with an ENOENT naming a file nobody wrote is the worst kind of red to debug.
 *
 * ENOENT only. Any other read failure (a permission, an I/O error) is something
 * we could not look at rather than something we looked at and found clean, and a
 * secret check that quietly skips what it cannot read is a check that passes by
 * not looking.
 */
function linesOf(file: string): string[] | null {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function findSentinels(roots: string[]): Finding[] {
  const findings: Finding[] = []
  for (const root of roots) {
    for (const file of walk(root)) {
      if (ALLOWED.some((a) => path.resolve(file).endsWith(a))) continue
      const lines = linesOf(file)
      if (lines === null) continue
      lines.forEach((text, i) => {
        for (const s of SENTINELS) {
          if (!s.pattern.test(text)) continue
          // The match is REDACTED out of the excerpt, and what is left is then
          // truncated. A check that prints the secret it found has moved the
          // secret into a CI log, which is a place with a longer retention than
          // the file it came from. Truncation alone does not do it: a short
          // line is a whole key, and `const key = "sk-ant-api03-SECRETSECRET"`
          // is thirty-nine characters. The `g` flag is added here because a
          // line can carry the same secret twice and `String.replace` without
          // it would leave the second one.
          const redacted = text.replace(new RegExp(s.pattern.source, 'g'), '[redacted]')
          findings.push({
            file, line: i + 1, sentinel: s.name,
            excerpt: `${redacted.trim().slice(0, 40)}...`,
          })
        }
      })
    }
  }
  return findings
}
