import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findSentinels, SENTINELS } from '../scripts/sentinels.js'

describe('the sentinel grep', () => {
  it('finds nothing in what this repository deploys', () => {
    // The check itself, run inside the suite, so `npm test` fails on a leak
    // rather than a deploy step somebody can skip.
    expect(findSentinels(['src', 'netlify', 'public'])).toEqual([])
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
    const found = findSentinels([dir])
    expect(found.map((f) => f.sentinel).sort()).toEqual(
      ['anthropic-key', 'planning-desk-prompt', 'public-secret', 'service-role-key'])
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
    expect(findSentinels(['src/desks'])).toEqual([])
  })

  it('names a reason for every pattern', () => {
    // The finding is read by whoever broke the build at five to six on a Friday.
    for (const s of SENTINELS) expect(s.why.length).toBeGreaterThan(40)
  })
})
