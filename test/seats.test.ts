import { SEATS, seatNameOf, withSeat, type Seat } from '../src/seats.js'

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
    const impostor: Seat = { model: SEATS.driver.model, effort: 'low' }
    expect(() => seatNameOf(impostor)).toThrow(/No seat named/)
  })
})
