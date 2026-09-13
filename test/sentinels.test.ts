import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findSentinels, SENTINELS } from '../scripts/sentinels.js'

describe('the sentinel grep', () => {
  it('finds nothing in the four directories this repository deploys or publishes', () => {
    // The check itself, run inside the suite, so `npm test` fails on a leak
    // rather than a deploy step somebody can skip. The four are the roots
    // `scripts/check-sentinels.ts` walks, and `evals` is the fourth from lesson
    // 6.1: a case file a reader opens is somewhere a prompt gets pasted, and a
    // root nobody walks is a root nobody checks.
    expect(findSentinels(['src', 'netlify', 'public', 'evals'])).toEqual([])
  })

  it('finds a planted key, so the empty result above means something', () => {
    // A check that has never gone red is a check nobody has tested. Every
    // pattern is planted, one file each, and every one has to be found.
    const dir = mkdtempSync(path.join(tmpdir(), 'sentinels-'))
    writeFileSync(path.join(dir, 'leak.ts'),
      'const key = "sk-ant-api03-AAAAAAAAAAAA"\n')
    writeFileSync(path.join(dir, 'env.ts'),
      'export const url = process.env.SUPABASE_SERVICE_ROLE_KEY\n')
    writeFileSync(path.join(dir, 'client.ts'),
      'const t = process.env.NEXT_PUBLIC_ANTHROPIC_TOKEN\n')
    writeFileSync(path.join(dir, 'inlined.ts'),
      'const prompt = "<!-- sentinel: GLOBETROTTY-PLANNING-DESK-PROMPT-DO-NOT-SHIP -->"\n')
    // The fifth, and the reason all five are planted rather than four. The
    // patterns spell GLOBETROTTY and the repository, the worktree and the module
    // all spell globtrotty; a single character of divergence between a pattern
    // and the prompt file it guards makes that pattern match nothing, for ever,
    // with every other test in this file still green. Test 1 and test 4 assert
    // emptiness and test 2 would simply not look.
    writeFileSync(path.join(dir, 'front.ts'),
      'const prompt = "<!-- sentinel: GLOBETROTTY-FRONT-DESK-PROMPT-DO-NOT-SHIP -->"\n')
    const found = findSentinels([dir])
    expect(found.map((f) => f.sentinel).sort()).toEqual(
      ['anthropic-key', 'front-desk-prompt', 'planning-desk-prompt', 'public-secret',
       'service-role-key'])
  })

  it('skips a file that disappears between the listing and the read', () => {
    // `walk` collects every path with readdirSync and findSentinels then reads
    // each one, so anything that removes a file inside that window turns the
    // check red with an ENOENT naming a file nobody wrote. It is a real window:
    // `test/desks.test.ts` writes src/desks/stray-desk.md and removes it in a
    // `finally`, vitest runs test files in parallel by default, and a
    // sub-millisecond race is the worst kind of red to debug.
    //
    // A broken symlink is that state, deterministically: readdirSync lists it
    // (withFileTypes uses lstat, so it is not a directory), and the read of it
    // fails with the same ENOENT.
    const dir = mkdtempSync(path.join(tmpdir(), 'sentinels-'))
    writeFileSync(path.join(dir, 'leak.ts'), 'const key = "sk-ant-api03-AAAAAAAAAAAA"\n')
    symlinkSync(path.join(dir, 'gone.ts'), path.join(dir, 'dangling.ts'))
    // The file that is still there is still found, which is the half that says
    // this tolerates a vanished file rather than swallowing the walk.
    expect(findSentinels([dir]).map((f) => f.sentinel)).toEqual(['anthropic-key'])
  })

  it('never prints the secret it found', () => {
    // A check that echoes the value into a CI log has moved the secret to a
    // place with a longer retention than the file it came from.
    const dir = mkdtempSync(path.join(tmpdir(), 'sentinels-'))
    writeFileSync(path.join(dir, 'leak.ts'), 'const key = "sk-ant-api03-SECRETSECRET"\n')
    const [f] = findSentinels([dir])
    expect(f!.excerpt).not.toContain('SECRETSECRET')
  })

  it('allows the prompts to contain their own sentinels', () => {
    // The prompt files are the source of truth for those strings. A check that
    // flagged them would be a check nobody could ever make pass.
    expect(findSentinels(['src/desks', 'src/agents/prompts'])).toEqual([])
  })

  it('names a reason for every pattern', () => {
    // The finding is read by whoever broke the build at five to six on a Friday.
    for (const s of SENTINELS) expect(s.why.length).toBeGreaterThan(40)
  })
})
