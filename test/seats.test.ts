import { PRICES } from '../src/pricing.js'
import { SEATS, seatNameOf, withSeat, type Seat, type SeatName } from '../src/seats.js'

describe('withSeat', () => {
  it('writes the driver seat as Opus at high effort', () => {
    const params = withSeat(SEATS.driver, { max_tokens: 10, messages: [] })
    expect(params.model).toBe('claude-opus-5')
    expect(params.output_config?.effort).toBe('high')
  })
  it('sends no effort field at all for the cheap seat', () => {
    const params = withSeat(SEATS.cheap, { max_tokens: 10, messages: [] })
    expect(params.model).toBe('claude-haiku-4-5-20251001')
    expect('output_config' in params).toBe(false)
  })
  it('keeps an output format the caller set', () => {
    const format = { type: 'json_schema' as const, schema: { type: 'object' } }
    const params = withSeat(SEATS.driver, { max_tokens: 10, messages: [], output_config: { format } })
    expect(params.output_config?.format).toEqual(format)
    expect(params.output_config?.effort).toBe('high')
  })
})

describe('seatNameOf', () => {
  it('names each real seat by which one it is', () => {
    expect(seatNameOf(SEATS.driver)).toBe('driver')
    expect(seatNameOf(SEATS.cheap)).toBe('cheap')
  })

  it('does not label a different seat as the driver just because it shares the driver\'s model', () => {
    // A hand-built seat pointed at the driver's model string, at a different
    // effort: two seats sharing a model is exactly the case a model-keyed
    // lookup cannot tell apart, and this one must not come back 'driver'.
    const impostor: Seat = {
      model: SEATS.driver.model, effort: 'low',
      maxTokens: 16_000, modelConfigId: 'claude-opus-5/low/16000',
    }
    expect(() => seatNameOf(impostor)).toThrow(/No seat named/)
  })
})

describe('the settings the seat carries', () => {
  it('puts the output ceiling on the seat rather than at the call site', () => {
    expect(SEATS.driver.maxTokens).toBe(16_000)
    // Eight times smaller than the 8000 `toolLoop` hardcoded for every seat,
    // which is the whole of the over-reservation this field removes.
    expect(SEATS.cheap.maxTokens).toBe(1_024)
  })

  it('encodes model, effort and ceiling into the config id', () => {
    expect(SEATS.driver.modelConfigId).toBe('claude-opus-5/high/16000')
    expect(SEATS.cheap.modelConfigId).toBe('claude-haiku-4-5-20251001/noeffort/1024')
  })

  it('prices every seat it declares', () => {
    // A seat with no price row throws at costMicros rather than charging zero
    // (src/pricing.ts), which would surface as a dead turn rather than as a
    // wrong number. Cheaper to fail here.
    for (const name of Object.keys(SEATS) as SeatName[]) {
      expect(PRICES[SEATS[name].model]).toBeDefined()
    }
  })
})
