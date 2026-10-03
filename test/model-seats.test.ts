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

  it('prices every Claude seat it declares — an unpriced seat would charge zero', () => {
    // Jev seats (model 'jev-latest') are costed by src/jev/client.ts's
    // jevCostMicros, not PRICES — PRICES is Claude token pricing only.
    for (const [name, seat] of Object.entries(SEATS)) {
      if (seat.model.startsWith('jev-')) continue
      expect(PRICES[seat.model], `seat ${name} has no price`).toBeDefined()
    }
  })

  it('gives every Claude seat but Haiku an effort, and Haiku none', () => {
    // Plan 5 Task 8 moved the driver to medium effort and the fix wave (C1)
    // kept it there while reverting the model to Opus 5: Sonnet 5 cannot carry
    // this repo's mid-conversation operator `system` messages. Opus takes an
    // effort parameter, unlike Haiku, which takes none at all.
    expect(SEATS.driver.effort).toBe('medium')
    expect(SEATS.reviewer.effort).toBe('high')   // still Opus
    expect(SEATS.scout.effort).toBeNull()        // Haiku takes no effort parameter
  })

  it('encodes model, effort and maxTokens in modelConfigId so a change is visible', () => {
    expect(SEATS.driver.modelConfigId).toContain('claude-opus-5')
    expect(SEATS.driver.modelConfigId).toContain('medium')
    expect(SEATS.driver.modelConfigId).toContain(String(SEATS.driver.maxTokens))
  })

  it('declares all ten seats the model_calls constraint allows', () => {
    expect(Object.keys(SEATS).sort()).toEqual(
      ['driver', 'front_desk', 'intake', 'monitor', 'rerank', 'reviewer', 'router', 'scout', 'sim_user', 'titler'],
    )
  })
})
