import { readFileSync } from 'node:fs'
import { DEFAULT_LIMITS, EVAL_LIMITS } from '../src/limits.js'

describe('the eval budget', () => {
  it('never raises the one ceiling that is shared with her', () => {
    // Cross-user and per UTC day. Raising it for the evals raises it for
    // production, which is a test suite loosening a money control.
    expect(EVAL_LIMITS.globalCeilingMicros).toBe(DEFAULT_LIMITS.globalCeilingMicros)
  })

  it('spends less per conversation than production allows, not more', () => {
    expect(EVAL_LIMITS.conversationCeilingMicros).toBeLessThan(DEFAULT_LIMITS.conversationCeilingMicros)
    expect(EVAL_LIMITS.dailyCeilingMicros).toBeLessThan(DEFAULT_LIMITS.dailyCeilingMicros)
  })

  it('keeps the step and supplier caps production uses, because they are not money', () => {
    // A shorter eval loop would measure a shorter loop. These two bound the
    // shape of the work rather than the bill, so they stay where they are.
    expect(EVAL_LIMITS.maxSteps).toBe(DEFAULT_LIMITS.maxSteps)
    expect(EVAL_LIMITS.maxSupplierCallsPerTurn).toBe(DEFAULT_LIMITS.maxSupplierCallsPerTurn)
  })

  it('keeps both Limits in src/limits.ts and adds no third there', () => {
    // src/limits.ts's own docstring: every tier that enforces a limit imports
    // this rather than redefining the numbers. A third object satisfying Limits
    // somewhere else would be a third opinion about a money ceiling.
    const src = readFileSync(new URL('../src/limits.ts', import.meta.url), 'utf8')
    expect(src.match(/: Limits = \{/g)).toHaveLength(2)
  })
})
