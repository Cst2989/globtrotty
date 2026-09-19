// There is no Netlify-hosted test harness in this repo (see the header comments on
// netlify/functions/run-turn-background.mts and sweep.mts), so `netlify.toml` itself has no
// other check on it. A regex/line parse against the raw file is enough to pin the handful of
// properties that would silently break a deploy if lost in a future edit: the Next.js plugin
// (Task 6 needs it to build/serve the app), the prompt files shipping with the function bundle
// (src/agents/driver.ts and friends `readFileSync` them at runtime — see driver.ts's doc
// comment on `import.meta.url`), and the two cron schedules the sweeper and drift monitor rely
// on to ever run at all.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TOML = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8')

describe('netlify.toml', () => {
  it('declares the Next.js plugin', () => {
    expect(TOML).toMatch(/\[\[plugins\]\]\s*\n\s*package\s*=\s*"@netlify\/plugin-nextjs"/)
  })

  it('ships the agent prompt files with the function bundle', () => {
    expect(TOML).toMatch(/included_files\s*=\s*\[\s*"src\/agents\/prompts\/\*\.md"\s*\]/)
  })

  it('keeps the sweep schedule at every five minutes', () => {
    expect(TOML).toMatch(/\[functions\."sweep"\]\s*\n\s*schedule\s*=\s*"\*\/5 \* \* \* \*"/)
  })

  it('keeps the drift-monitor schedule at 03:00 daily', () => {
    expect(TOML).toMatch(/\[functions\."drift-monitor"\]\s*\n\s*schedule\s*=\s*"0 3 \* \* \*"/)
  })

  it('keeps the esbuild bundler', () => {
    expect(TOML).toMatch(/node_bundler\s*=\s*"esbuild"/)
  })
})
