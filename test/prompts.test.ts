import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPrompt } from '../src/agents/prompts/load.js'

describe('loadPrompt', () => {
  it('returns the driver prompt text', () => {
    expect(loadPrompt('driver')).toContain('planning desk')
  })

  it('falls back to the process-cwd path when nothing is beside `from`', () => {
    // A temp dir has no driver.md beside it, so `beside` misses. The real
    // process.cwd() here is still the repo root (nothing below chdirs), so the
    // second candidate — cwd-relative `src/agents/prompts/driver.md` — hits,
    // exactly the branch the esbuild-bundled Netlify function relies on.
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'loadPrompt-empty-'))
    const from = pathToFileURL(path.join(emptyDir, 'bundle.mjs')).href
    expect(loadPrompt('driver', from)).toBe(loadPrompt('driver'))
  })

  it('throws naming both candidate paths when neither exists', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'loadPrompt-beside-'))
    const fakeCwd = mkdtempSync(path.join(tmpdir(), 'loadPrompt-cwd-'))
    const from = pathToFileURL(path.join(emptyDir, 'bundle.mjs')).href
    const besidePath = path.join(emptyDir, 'driver.md')

    const realCwd = process.cwd()
    process.chdir(fakeCwd)
    try {
      // `process.cwd()` post-chdir, not the pre-chdir `fakeCwd` string: on macOS
      // `/tmp` is a symlink to `/private/tmp`, and `chdir` resolves it, so the
      // path `loadPrompt` actually builds from `process.cwd()` differs from the
      // literal string handed to `mkdtempSync`/`chdir`.
      const cwdPath = path.join(process.cwd(), 'src', 'agents', 'prompts', 'driver.md')
      expect(() => loadPrompt('driver', from)).toThrow(
        `loadPrompt: driver.md not found at ${besidePath} or ${cwdPath}`,
      )
    } finally {
      process.chdir(realCwd)
    }
  })
})
