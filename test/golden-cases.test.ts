import { GoldenCaseSchema, loadGoldenCases } from '../src/evals/cases.js'

describe('the frozen cases', () => {
  const cases = loadGoldenCases()

  it('parses every case in the file', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3)
  })

  it('carries a case whose right answer is no', () => {
    // P3: an agency that never says no is an agency that invents. A suite whose
    // every case expects a proposal is a suite that teaches it to invent one.
    const refusal = cases.find((c) => c.expect.proposals === 0)
    expect(refusal).toBeDefined()
    expect(refusal!.expect.gates).toBe('any fail')
  })

  it('gives every case a unique id, because the id is the seed', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
  })

  it('refuses a case with a key nobody defined', () => {
    const good = { ...cases[0]! }
    const bad = { ...good, expect: { ...good.expect, maxFrontierCall: 4 } }
    expect(() => GoldenCaseSchema.parse(bad)).toThrow()
  })

  it('refuses a range that cannot be satisfied', () => {
    const good = cases[0]!
    const bad = { ...good, expect: { ...good.expect, maxFrontierCalls: 0 } }
    expect(() => GoldenCaseSchema.parse(bad)).toThrow()
  })
})
