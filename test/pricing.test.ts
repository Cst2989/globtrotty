import { costMicros, PRICES, dollars } from '../src/pricing.js'

describe('costMicros', () => {
  it('prices an Opus call from the four usage fields and rounds up', () => {
    const micros = costMicros('claude-opus-5', {
      input_tokens: 1000, output_tokens: 100,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    }, '5m')
    expect(micros).toBe(BigInt(1000 * 5 + 100 * 25))
  })
  it('charges cache reads at a tenth of the input rate', () => {
    const micros = costMicros('claude-opus-5', {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 1000,
    }, '5m')
    expect(micros).toBe(500n)
  })
  it('refuses to price a model it does not know', () => {
    expect(() => costMicros('claude-unknown', { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '5m')).toThrow(/Refusing/)
  })
  it('knows both seats we will staff', () => {
    expect(Object.keys(PRICES)).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001'])
  })
  it('prints micros as dollars', () => {
    expect(dollars(12_500n)).toBe('$0.0125')
  })
})
