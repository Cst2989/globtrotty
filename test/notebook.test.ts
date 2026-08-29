import { applyRequirements, emptyNotebook } from '../src/notebook.js'

const AT = '2026-08-29T10:00:00Z'

describe('notebook', () => {
  it('records what she said with her as the source', () => {
    const nb = applyRequirements(emptyNotebook(), { budget: { amount: 1500, currency: 'EUR' } }, 'user', AT)
    expect(nb.budget).toEqual({ value: { amount: 1500, currency: 'EUR' }, source: 'user', at: AT })
  })
  it('lets her lower her own budget on a later turn', () => {
    const first = applyRequirements(emptyNotebook(), { budget: { amount: 1500, currency: 'EUR' } }, 'user', AT)
    const second = applyRequirements(first, { budget: { amount: 1200, currency: 'EUR' } }, 'user', AT)
    expect(second.budget?.value.amount).toBe(1200)
  })
  it('refuses a tool that would raise her budget', () => {
    const first = applyRequirements(emptyNotebook(), { budget: { amount: 1200, currency: 'EUR' } }, 'user', AT)
    const second = applyRequirements(first, { budget: { amount: 1500, currency: 'EUR' } }, 'tool', AT)
    expect(second.budget?.value.amount).toBe(1200)
    expect(second.budget?.source).toBe('user')
  })
  it('does not let an inference overwrite her words', () => {
    const first = applyRequirements(emptyNotebook(), { destination: 'Portugal' }, 'user', AT)
    const second = applyRequirements(first, { destination: 'Spain' }, 'inferred', AT)
    expect(second.destination?.value).toBe('Portugal')
  })
  it('lets a tool tighten a constraint', () => {
    const first = applyRequirements(emptyNotebook(), { nights: 7 }, 'inferred', AT)
    const second = applyRequirements(first, { nights: 6 }, 'tool', AT)
    expect(second.nights?.value).toBe(6)
  })
})
