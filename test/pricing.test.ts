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

describe('a write that went out at two TTLs at once', () => {
  // What a driver request actually sends: one 1h breakpoint on the system head
  // and up to three 5m ones on the transcript (src/model/cache.ts). The total in
  // `cache_creation_input_tokens` is the sum across both buckets and cannot say
  // how it divided, so the provider's own split is the only thing that can
  // price it.
  const MIXED = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 10_000,
    cache_creation: { ephemeral_5m_input_tokens: 8_000, ephemeral_1h_input_tokens: 2_000 },
  }

  it('prices each bucket at its own rate when the provider reports the split', () => {
    // 8,000 at 1.25 and 2,000 at 2, both times five micros in: 50,000 + 20,000.
    expect(costMicros('claude-opus-5', MIXED, '1h')).toBe(70_000n)
  })

  it('reads the split rather than the declared TTL, whichever TTL is declared', () => {
    // The assertion that discriminates. An implementation that ignored the split
    // would answer 100,000 for '1h' and 62,500 for '5m', so a single-TTL fixture
    // cannot tell the two implementations apart and this one can: the answer is
    // the same either way, because the response said what it wrote.
    expect(costMicros('claude-opus-5', MIXED, '5m'))
      .toBe(costMicros('claude-opus-5', MIXED, '1h'))
  })

  it('prices the whole write at the declared TTL when there is no split', () => {
    // The fallback, and the reason the declared TTL is still a required
    // argument. Every call site that can write a cache declares 1h, the dearer
    // of the two rates, so a mixed write with no split is over-stated and never
    // under-stated, which is the only direction a spend figure may be wrong in.
    const noSplit = { ...MIXED, cache_creation: undefined }
    expect(costMicros('claude-opus-5', noSplit, '1h')).toBe(100_000n)
    expect(costMicros('claude-opus-5', noSplit, '1h'))
      .toBeGreaterThan(costMicros('claude-opus-5', MIXED, '1h'))
    // Null and absent are the same thing here: `usageOf` writes null where the
    // provider reported nothing, and a hand-written fixture simply omits it.
    expect(costMicros('claude-opus-5', { ...MIXED, cache_creation: null }, '1h')).toBe(100_000n)
  })

  it('still refuses a TTL it has no rate for, even with a split to fall back on', () => {
    // The TTL is validated on both paths. Reading it only in the fallback would
    // mean a bad argument was silently accepted on every real response and threw
    // only on the ones that happened to carry no split.
    expect(() => costMicros('claude-opus-5', MIXED, '30m' as never)).toThrow(/Refusing to guess/)
  })
})
