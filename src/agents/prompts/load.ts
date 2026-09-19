import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Prompt files ship as files so `promptVersion` points at a reviewable diff (see the doc
 * comment that used to sit on each seat's own `readFileSync(new URL(...))` line). There are
 * two places they can live at runtime:
 *
 *  - beside this module (tsx, vitest, a plain Next.js server render) — `import.meta.url`
 *    still neighbours `driver.md` etc. because nothing has repackaged the source tree.
 *  - at the repo-relative path from the process cwd (a Netlify function bundle): esbuild
 *    folds every seat's module into ONE function file, so `import.meta.url` inside that
 *    bundle points at `netlify/functions/run-turn-background.mjs`, not at
 *    `src/agents/prompts/`. `netlify.toml`'s `included_files` instead copies the `.md`
 *    files into the zip at their repo-relative path, `src/agents/prompts/*.md`, and Netlify
 *    runs the function with the zip root as `process.cwd()` — so the second candidate path
 *    is built from `process.cwd()`, not from `import.meta.url` at all.
 *
 * `from` defaults to this module's own `import.meta.url` so every call site gets the "beside
 * this module" candidate for free; a test overrides it to point `existsSync` at a directory
 * that deliberately has no `.md` file, to exercise the cwd fallback and the final throw.
 */
export function loadPrompt(
  name: 'driver' | 'front_desk' | 'scout' | 'reviewer',
  from: string = import.meta.url,
): string {
  const beside = fileURLToPath(new URL(`./${name}.md`, from))
  if (existsSync(beside)) return readFileSync(beside, 'utf8')
  const fromCwd = path.join(process.cwd(), 'src', 'agents', 'prompts', `${name}.md`)
  if (existsSync(fromCwd)) return readFileSync(fromCwd, 'utf8')
  throw new Error(`loadPrompt: ${name}.md not found at ${beside} or ${fromCwd}`)
}
