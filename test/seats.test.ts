import { SEATS, withSeat } from '../src/seats.js'

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
