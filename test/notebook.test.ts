import { applyRequirements, emptyNotebook } from '../src/notebook.js'
import { money } from '../src/money.js'

const AT = '2026-08-29T10:00:00Z'

describe('notebook', () => {
  it('records what she said with her as the source', () => {
    const { next, rejected } = applyRequirements(
      emptyNotebook(), { budget: money(150000n, 'EUR') }, 'user', AT)
    expect(next.budget).toEqual({ value: money(150000n, 'EUR'), source: 'user', at: AT })
    expect(rejected).toEqual([])
  })
  it('lets her lower her own budget on a later turn', () => {
    const { next: first } = applyRequirements(
      emptyNotebook(), { budget: money(150000n, 'EUR') }, 'user', AT)
    const { next: second } = applyRequirements(first, { budget: money(120000n, 'EUR') }, 'user', AT)
    expect(second.budget?.value.minor).toBe(120000n)
  })
  it('refuses a tool that would raise her budget', () => {
    const { next: first } = applyRequirements(
      emptyNotebook(), { budget: money(120000n, 'EUR') }, 'user', AT)
    const { next: second, rejected } = applyRequirements(
      first, { budget: money(150000n, 'EUR') }, 'tool', AT)
    expect(second.budget?.value.minor).toBe(120000n)
    expect(second.budget?.source).toBe('user')
    // Named, not merely dropped. A model told "recorded" after a silent refusal
    // sends the same value again on its next step; a model told which key was
    // refused can ask her instead (lesson 5.2).
    expect(rejected).toEqual(['budget'])
  })
  it('refuses a tool that answers in another currency, rather than converting', () => {
    const { next: first } = applyRequirements(
      emptyNotebook(), { budget: money(120000n, 'EUR') }, 'user', AT)
    const { next: second, rejected } = applyRequirements(
      first, { budget: money(100000n, 'USD') }, 'tool', AT)
    expect(second.budget?.value).toEqual(money(120000n, 'EUR'))
    expect(rejected).toEqual(['budget'])
  })
  it('does not let an inference overwrite her words', () => {
    const { next: first } = applyRequirements(emptyNotebook(), { destination: 'Portugal' }, 'user', AT)
    const { next: second, rejected } = applyRequirements(first, { destination: 'Spain' }, 'inferred', AT)
    expect(second.destination?.value).toBe('Portugal')
    expect(rejected).toEqual(['destination'])
  })
  it('lets a tool tighten a constraint', () => {
    const { next: first } = applyRequirements(emptyNotebook(), { nights: 7 }, 'inferred', AT)
    const { next: second, rejected } = applyRequirements(first, { nights: 6 }, 'tool', AT)
    expect(second.nights?.value).toBe(6)
    expect(rejected).toEqual([])
  })
})
