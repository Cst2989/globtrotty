import { applyRequirements, emptyNotebook } from '../src/notebook.js'
import { money } from '../src/money.js'

const AT = '2026-08-29T10:00:00Z'

describe('notebook', () => {
  it('records what she said with her as the source', () => {
    const nb = applyRequirements(emptyNotebook(), { budget: money(150000n, 'EUR') }, 'user', AT)
    expect(nb.budget).toEqual({ value: money(150000n, 'EUR'), source: 'user', at: AT })
  })
  it('lets her lower her own budget on a later turn', () => {
    const first = applyRequirements(emptyNotebook(), { budget: money(150000n, 'EUR') }, 'user', AT)
    const second = applyRequirements(first, { budget: money(120000n, 'EUR') }, 'user', AT)
    expect(second.budget?.value.minor).toBe(120000n)
  })
  it('refuses a tool that would raise her budget', () => {
    const first = applyRequirements(emptyNotebook(), { budget: money(120000n, 'EUR') }, 'user', AT)
    const second = applyRequirements(first, { budget: money(150000n, 'EUR') }, 'tool', AT)
    expect(second.budget?.value.minor).toBe(120000n)
    expect(second.budget?.source).toBe('user')
  })
  it('refuses a tool that answers in another currency, rather than converting', () => {
    const first = applyRequirements(emptyNotebook(), { budget: money(120000n, 'EUR') }, 'user', AT)
    const second = applyRequirements(first, { budget: money(100000n, 'USD') }, 'tool', AT)
    expect(second.budget?.value).toEqual(money(120000n, 'EUR'))
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
