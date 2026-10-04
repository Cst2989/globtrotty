// There is no Netlify-hosted test harness in this repo (see the header comments on
// netlify/functions/run-turn-background.mts and sweep.mts), so `netlify.toml` itself has no
// other check on it. A regex/line parse against the raw file is enough to pin the handful of
// properties that would silently break a deploy if lost in a future edit: the Next.js plugin
// (Task 6 needs it to build/serve the app), the prompt files shipping with the function bundle
// (src/agents/prompts/load.ts reads them via `loadPrompt` at runtime), and the two cron
// schedules the sweeper and drift monitor rely on to ever run at all.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TOML = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8')
const REPO_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Every `.ts` file under `dir`, recursively. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('netlify.toml', () => {
  it('declares the Next.js plugin', () => {
    expect(TOML).toMatch(/\[\[plugins\]\]\s*\n\s*package\s*=\s*"@netlify\/plugin-nextjs"/)
  })

  it('ships the agent prompt files with the function bundle', () => {
    expect(TOML).toMatch(/included_files\s*=\s*\[\s*"src\/agents\/prompts\/\*\.md"\s*\]/)
  })

  it('keeps the sweep schedule at every minute (a queued turn must never wait five)', () => {
    expect(TOML).toMatch(/\[functions\."sweep"\]\s*\n\s*schedule\s*=\s*"\* \* \* \* \*"/)
  })

  it('keeps the drift-monitor schedule at 03:00 daily', () => {
    expect(TOML).toMatch(/\[functions\."drift-monitor"\]\s*\n\s*schedule\s*=\s*"0 3 \* \* \*"/)
  })

  it('keeps the esbuild bundler', () => {
    expect(TOML).toMatch(/node_bundler\s*=\s*"esbuild"/)
  })
})

// Fix round 1 (plan 4a, Task 5 review, Critical): `readFileSync(new URL('./prompts/x.md',
// import.meta.url))` resolves against the SOURCE file's location. Once esbuild bundles a
// function, every seat's module is folded into one bundle file, so that URL no longer
// neighbours `src/agents/prompts/` — ENOENT at module init on every real invocation, caught
// only by the reviewer running the bundle through `@netlify/zip-it-and-ship-it`, not by
// `pnpm test`. `src/agents/prompts/load.ts`'s `loadPrompt` is the one place allowed to build a
// prompt path from `import.meta.url`; this pins that the pattern cannot come back anywhere
// else under `src/agents/` or `src/monitor/`.
describe('prompt file paths', () => {
  it('never resolves a prompts/ path from import.meta.url outside src/agents/prompts/load.ts', () => {
    const dirs = ['src/agents', 'src/monitor'].map((d) => path.join(REPO_ROOT, d))
    const offenders: string[] = []
    for (const dir of dirs) {
      for (const file of tsFilesUnder(dir)) {
        if (file === path.join(REPO_ROOT, 'src/agents/prompts/load.ts')) continue
        const text = readFileSync(file, 'utf8')
        // A `new URL(` call whose first argument string contains `prompts/` — the exact shape
        // that breaks once esbuild bundles the module away from its source location.
        if (/new URL\(\s*['"`][^'"`]*prompts\//.test(text)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
