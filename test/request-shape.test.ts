import { buildCountTokensRequest, buildRequest, estimateInputTokens, withSuffix } from '../src/model/client.js'
import type { CallArgs } from '../src/model/client.js'
import type { LoopMessage } from '../src/engine.js'
import { SEATS } from '../src/seats.js'

const user = (text: string): LoopMessage => ({ role: 'user', content: [{ type: 'text', text }] })

const base: CallArgs = {
  seat: SEATS.driver,
  system: 'You are the planning desk.',
  messages: [user('Portugal in September, 1500 euros, one toddler')],
  tools: [],
}

/**
 * Every key at every depth of an assembled request, arrays included. A top-level
 * `not.toHaveProperty` cannot answer this question: `cache_control` is a
 * per-BLOCK field, so it would appear on a system block, a tool definition or
 * the last content block of a message, never beside `model`.
 */
function everyKey(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, found)
    return found
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key)
      everyKey(inner, found)
    }
  }
  return found
}

describe('the request we actually send', () => {
  it('never carries budget_tokens', () => {
    // The one assertion in this file that looks redundant and is not. Opus 5
    // returns 400 for `thinking: {type:'enabled', budget_tokens: N}`, and the
    // installed SDK's types still accept that shape because they are model
    // agnostic, so `npm run typecheck` is green either way. Deleting this test
    // as redundant restores a silent 400 on every call.
    const req = buildRequest(base)
    expect(JSON.stringify(req)).not.toContain('budget_tokens')
    expect(req.thinking).toEqual({ type: 'adaptive' })
  })

  it('puts effort inside output_config and never at the top level', () => {
    const req = buildRequest(base)
    expect(req.output_config).toEqual({ effort: 'high' })
    expect(req).not.toHaveProperty('effort')
  })

  it('omits output_config entirely for a seat with no effort', () => {
    // Not `{ effort: null }`. Haiku 4.5 takes no effort parameter, and sending
    // the key with a null is a different request from not sending the key.
    const req = buildRequest({ ...base, seat: SEATS.cheap })
    expect(req).not.toHaveProperty('output_config')
  })

  it('takes max_tokens from the seat', () => {
    expect(buildRequest(base).max_tokens).toBe(16_000)
    expect(buildRequest({ ...base, seat: SEATS.cheap }).max_tokens).toBe(1_024)
  })

  it('never ends on an assistant turn, because a prefill is a 400 on Opus 5', () => {
    const withAssistant: LoopMessage[] = [
      user('Portugal please'),
      { role: 'assistant', content: [{ type: 'text', text: 'Which month?' }] },
    ]
    const out = withSuffix(withAssistant, '## The notebook\n\n- destination: "Portugal"')
    expect(out.at(-1)!.role).toBe('user')
    expect(out).toHaveLength(3)
  })

  it('appends the suffix to a trailing user turn rather than opening a second one', () => {
    // Two consecutive user turns is a malformed transcript. Appending a block to
    // the existing one keeps the shape legal and keeps the notebook after the
    // last block, which is where lesson 5.6 puts the cache breakpoint.
    const out = withSuffix([user('Portugal please')], 'notebook')
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toHaveLength(2)
    expect((out[0]!.content[1] as { text: string }).text).toBe('notebook')
  })

  it('leaves the transcript alone when there is no suffix', () => {
    const messages = [user('Portugal please')]
    expect(withSuffix(messages, undefined)).toBe(messages)
    expect(withSuffix(messages, '')).toBe(messages)
  })

  it('carries the suffix into the assembled request, not only into withSuffix', () => {
    const req = buildRequest({ ...base, suffix: '## The notebook' })
    expect(JSON.stringify(req.messages)).toContain('## The notebook')
  })

  it('sends tools only when there are some', () => {
    expect(buildRequest(base)).not.toHaveProperty('tools')
    const withTools = buildRequest({ ...base, tools: [{ name: 'search_hotels' }] })
    expect(withTools.tools).toEqual([{ name: 'search_hotels' }])
  })

  it('carries no cache_control anywhere in it', () => {
    // Load bearing, and pinned nowhere until this case. The reservation's bound
    // (src/repo/reservation.ts) rests on the sentence "nothing this lesson sends
    // carries cache_control", which is what keeps `cache_creation_input_tokens`
    // at zero on the way back. Lesson 5.6 puts a 1h cache TTL on every driver
    // call, a 1h write bills at twice base input rather than the 1.25 the bound
    // assumes, and this is the case that goes red in the commit that adds the
    // breakpoint without moving the bound with it.
    const req = buildRequest({
      ...base,
      // The branchy parts of the request, so the search covers the places a
      // breakpoint is actually written: the tool definitions and a multi-block
      // trailing user turn.
      tools: [{ name: 'search_hotels', input_schema: { type: 'object' } }],
      suffix: '## The notebook\n\n- destination: "Portugal"',
    })
    expect(everyKey(req)).not.toContain('cache_control')
  })

  it('never sends temperature', () => {
    expect(buildRequest(base)).not.toHaveProperty('temperature')
  })

  it('counts tokens against the same prompt it dispatches, minus max_tokens', () => {
    // The counting endpoint is not being asked to produce output and rejects an
    // output ceiling. Everything else is field for field the dispatched request,
    // because a reservation computed from a different prompt is not a bound on
    // the one that was sent.
    const args = { ...base, suffix: '## The notebook' }
    const counting = buildCountTokensRequest(args)
    const dispatched = buildRequest(args)
    expect(counting).not.toHaveProperty('max_tokens')
    const { max_tokens: _dropped, ...rest } = dispatched
    expect(counting).toEqual(rest)
  })

  it('counts the suffix, because the estimate is built from the request', () => {
    // The failure this pins: an estimator that read args.system, args.messages
    // and args.tools would count a 2,240 character notebook as zero, and the
    // undercount grows with the notebook rather than being a fixed offset.
    const without = estimateInputTokens(base)
    const with_ = estimateInputTokens({ ...base, suffix: 'x'.repeat(3_000) })
    expect(with_).toBeGreaterThan(without + 900)
  })

  it('measures UTF-8 bytes rather than UTF-16 code units', () => {
    // A CJK character is roughly one token, three UTF-8 bytes and one code
    // unit, so dividing `.length` by three undercounts CJK input by about
    // three times. The estimate feeds the reservation, and an undercount is the
    // one direction a money guardrail may not err in.
    const ascii = estimateInputTokens({ ...base, suffix: 'a'.repeat(300) })
    const cjk = estimateInputTokens({ ...base, suffix: '葡'.repeat(300) })
    expect(cjk).toBeGreaterThan(ascii * 2)
  })
})
