import { describe, expect, it } from 'vitest'
import { SEATS } from '../src/model/seats.js'
import { PRICES } from '../src/pricing.js'

describe('SEATS', () => {
  it('pins exact model ids — no invented date suffixes', () => {
    // claude-opus-5 has NO dated snapshot; appending a date 404s.
    expect(SEATS.driver.model).toBe('claude-opus-5')
    // Haiku 4.5 is the one current model WITH a real dated snapshot, so it is
    // the one seat that can be pinned exactly. Spec section 7.
    expect(SEATS.scout.model).toBe('claude-haiku-4-5-20251001')
  })

  it('prices every seat it declares — an unpriced seat would charge zero', () => {
    for (const [name, seat] of Object.entries(SEATS)) {
      expect(PRICES[seat.model], `seat ${name} has no price`).toBeDefined()
    }
  })

  it('gives Opus seats an effort and Haiku none', () => {
    expect(SEATS.driver.effort).toBe('high')
    expect(SEATS.scout.effort).toBeNull()   // Haiku takes no effort parameter
  })

  it('encodes model, effort and maxTokens in modelConfigId so a change is visible', () => {
    expect(SEATS.driver.modelConfigId).toContain('claude-opus-5')
    expect(SEATS.driver.modelConfigId).toContain('high')
    expect(SEATS.driver.modelConfigId).toContain(String(SEATS.driver.maxTokens))
  })

  it('declares all seven seats the model_calls constraint allows', () => {
    expect(Object.keys(SEATS).sort()).toEqual(
      ['driver', 'front_desk', 'monitor', 'reviewer', 'scout', 'sim_user', 'titler'],
    )
  })
})
