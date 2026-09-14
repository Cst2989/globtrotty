import { randomUUID } from 'node:crypto'
import { assignVariant, variantFor, RELEASE } from '../src/loop/release.js'
import { loadDesk } from '../src/desks.js'

describe('the release canary assignment', () => {
  it('assigns nobody at zero and everybody at a hundred', () => {
    const ids = Array.from({ length: 50 }, () => randomUUID())
    expect(ids.every((id) => assignVariant(id, 0) === 'control')).toBe(true)
    expect(ids.every((id) => assignVariant(id, 100) === 'candidate')).toBe(true)
  })

  it('gives one conversation the same answer every time it is asked', () => {
    const id = randomUUID()
    const answers = new Set(Array.from({ length: 20 }, () => assignVariant(id, 50)))
    // The property a resumed turn depends on: the sweeper re-runs a turn from
    // step 0 and it has to read the prompt the conversation started with.
    expect(answers.size).toBe(1)
  })

  it('splits roughly where it was told to, over enough conversations', () => {
    const ids = Array.from({ length: 2000 }, () => randomUUID())
    const candidates = ids.filter((id) => assignVariant(id, 20) === 'candidate').length
    // A range and not a number, because this is a hash and not a quota. The
    // window is wide enough that the case is not flaky and narrow enough that
    // a hash returning a constant would fail it, which is the only fault this
    // assertion is for.
    expect(candidates).toBeGreaterThan(2000 * 0.15)
    expect(candidates).toBeLessThan(2000 * 0.25)
  })

  it('refuses a rollout nobody could have meant', () => {
    expect(() => assignVariant(randomUUID(), 150)).toThrow(/whole percent/)
    expect(() => assignVariant(randomUUID(), -1)).toThrow(/whole percent/)
  })

  it('serves two distinguishable prompts, which is what a comparison needs', () => {
    const control = loadDesk('planning', 'control')
    const candidate = loadDesk('planning', 'candidate')
    expect(control.promptVersion).not.toBe(candidate.promptVersion)
    expect(control.variant).toBe('control')
    expect(candidate.variant).toBe('candidate')
    // And the switch is shipped off, so nobody on this branch is in the
    // candidate arm until somebody commits a different number.
    expect(RELEASE.rolloutPercent).toBe(0)
    expect(variantFor(randomUUID())).toBe('control')
  })
})
