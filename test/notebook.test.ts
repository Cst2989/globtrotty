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

  // Superseded by the coordinator's ruling below: budget is uniquely
  // sensitive, so a `tool` source is refused for *every* write to it, even
  // a tightening one that would be harmless for other constraint fields.
  // (Originally this test asserted the tightening was accepted; see the
  // maxStops/nights tests further down for that pattern, which still holds
  // for those fields.)
  it('REFUSES a tool write to budget even when it would tighten the constraint', () => {
    const { next, rejected } = applyRequirements(base(),
      { budget: { minor: '100000', currency: 'EUR' } }, 'tool')
    expect(next.budget?.value.minor).toBe(150000n)   // unchanged
    expect(rejected).toEqual(['budget'])
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

  // Ruled behaviour: a patch mixing a valid field with an unrecognised key
  // is rejected wholesale, not applied field by field. Partially applying an
  // attacker-influenced patch is a worse failure than discarding it, and
  // `rejected` still names every offending key.
  it('rejects a mixed patch wholesale, applying neither the valid nor the invalid field', () => {
    const { next, rejected } = applyRequirements(base(),
      { nights: 10, sneaky: true }, 'user')
    expect(rejected).toEqual(['sneaky'])
    expect(next.nights?.value).toBe(7)   // unchanged — the valid field was NOT applied
  })

  // A `tool` source may never establish or relax `budget` — not even a
  // first write on an empty notebook, since a downstream money gate would
  // validate against a value that originated in attacker-controlled content.
  it('REFUSES a tool from establishing budget on an empty notebook', () => {
    const { next, rejected } = applyRequirements(emptyNotebook(),
      { budget: { minor: '500000', currency: 'EUR' } }, 'tool')
    expect(next.budget).toBeNull()
    expect(rejected).toEqual(['budget'])
  })

  it('lets an inferred source establish budget on an empty notebook', () => {
    const { next, rejected } = applyRequirements(emptyNotebook(),
      { budget: { minor: '80000', currency: 'EUR' } }, 'inferred')
    expect(next.budget?.value.minor).toBe(80000n)
    expect(next.budget?.source).toBe('inferred')
    expect(rejected).toEqual([])
  })

  // maxStops and nights go through the same CONSTRAINT_FIELDS/relaxes()
  // path as budget's relax-only guard did before the budget-specific rule
  // above. These prove that path is reachable and correct for both fields.
  it('REFUSES to let a tool relax maxStops', () => {
    const withStops = applyRequirements(base(), { maxStops: 1 }, 'user').next
    const { next, rejected } = applyRequirements(withStops, { maxStops: 2 }, 'tool')
    expect(next.maxStops?.value).toBe(1)   // unchanged
    expect(rejected).toEqual(['maxStops'])
  })

  it('lets a tool tighten maxStops', () => {
    const withStops = applyRequirements(base(), { maxStops: 1 }, 'user').next
    const { next, rejected } = applyRequirements(withStops, { maxStops: 0 }, 'tool')
    expect(next.maxStops?.value).toBe(0)
    expect(rejected).toEqual([])
  })

  it('REFUSES to let a tool relax nights', () => {
    const { next, rejected } = applyRequirements(base(), { nights: 10 }, 'tool')
    expect(next.nights?.value).toBe(7)   // unchanged
    expect(rejected).toEqual(['nights'])
  })

  it('lets a tool tighten nights', () => {
    const { next, rejected } = applyRequirements(base(), { nights: 5 }, 'tool')
    expect(next.nights?.value).toBe(5)
    expect(rejected).toEqual([])
  })
})
