import { describe, it, expect } from 'vitest'
import { emptyNotebook, applyRequirements } from '../src/notebook.js'

const base = () =>
  applyRequirements(emptyNotebook(), {
    budget: { minor: '150000', currency: 'EUR' },
    partySize: { adults: 2, infants: 1 },
    nights: 7,
  }, 'user').next

describe('applyRequirements', () => {
  it('records values with their source', () => {
    const n = base()
    expect(n.budget?.value.minor).toBe(150000n)
    expect(n.budget?.source).toBe('user')
  })

  it('leaves unstated fields null rather than guessing', () => {
    expect(emptyNotebook().budget).toBeNull()
    expect(emptyNotebook().destination).toBeNull()
  })

  it('lets a user relax a constraint', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '500000', currency: 'EUR' } }, 'user')
    expect(next.budget?.value.minor).toBe(500000n)
    expect(rejected).toEqual([])
  })

  // The injection case from spec section 10.
  it('REFUSES to let a tool relax a constraint', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '500000', currency: 'EUR' } }, 'tool')
    expect(next.budget?.value.minor).toBe(150000n)   // unchanged
    expect(rejected).toEqual(['budget'])
  })

  it('lets a tool TIGHTEN a constraint, which is harmless', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '100000', currency: 'EUR' } }, 'tool')
    expect(next.budget?.value.minor).toBe(100000n)
    expect(rejected).toEqual([])
  })

  it('refuses a budget in a different currency than the one already set', () => {
    const { rejected } = applyRequirements(base(),
      { budget: { minor: '100000', currency: 'GBP' } }, 'user')
    expect(rejected).toEqual(['budget'])
  })

  it('rejects unknown keys instead of storing them', () => {
    const { next, rejected } = applyRequirements(base(), { sneaky: true }, 'user')
    expect(rejected).toEqual(['sneaky'])
    expect(next).not.toHaveProperty('sneaky')
  })

  it('marks inferred facts as inferred', () => {
    const { next } = applyRequirements(base(), { nearBeach: true }, 'inferred')
    expect(next.nearBeach?.source).toBe('inferred')
  })

  // Not in the brief, but the whole point of this module is to survive
  // attacker-controlled input without crashing the turn.
  it('rejects a budget with an unknown currency instead of throwing', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '100000', currency: 'XYZ' } }, 'user')
    expect(rejected).toEqual(['budget'])
    expect(next.budget?.value.currency).toBe('EUR')
  })
})
