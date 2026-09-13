import { buildCountTokensRequest, buildRequest, estimateInputTokens, withSuffix } from '../src/model/client.js'
import type { CallArgs } from '../src/model/client.js'
import type { LoopMessage } from '../src/engine.js'
import { SEATS } from '../src/seats.js'
import { toolsForDesk } from '../src/tools/registry.js'

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

  it("omits tools entirely for the front desk, so the model is offered no door", () => {
    // The front desk's half of the claim `src/agents/driver.ts` and its
    // docstring both lean on: the `tool_use` branch is unreachable for it by
    // construction and not by a check. `test/desks.test.ts` proves the registry
    // half (`toolsForDesk('front')` is empty) and this proves the request half,
    // which is the one that decides what the model is actually offered.
    //
    // `tools: []` is not the same request as no `tools` key. An empty array is a
    // published, empty tool list, and a model handed one has been told the
    // subject exists; the front desk is told nothing of the kind.
    const req = buildRequest({ ...base, seat: SEATS.front_desk, tools: toolsForDesk('front') })
    expect(req).not.toHaveProperty('tools')
    expect(everyKey(req)).not.toContain('tools')
    // And the same assembler does publish them when a desk has some, so the line
    // above is about this desk and not about a function that never sends tools.
    expect(buildRequest({ ...base, tools: toolsForDesk('planning') })).toHaveProperty('tools')
  })

  it('omits thinking entirely for a seat with no effort', () => {
    // Haiku 4.5 answers `400 invalid_request_error: adaptive thinking is not
    // supported on this model`, so this is not a tidiness rule: a scout call
    // (lesson 5.4) and a front-desk step (lesson 5.3) both run on a Haiku seat
    // through this assembler, and both fail every time with the key present if
    // `thinking` rides along. The driver's own case above pins the other half.
    const req = buildRequest({ ...base, seat: SEATS.scout })
    expect(req).not.toHaveProperty('thinking')
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

  it('carries a breakpoint on the system head and one on the transcript', () => {
    // The inversion of the case this replaces. Until lesson 5.6 this file
    // asserted that NO cache_control appeared anywhere, and that assertion was
    // load bearing: the reservation's bound (src/repo/reservation.ts) rested on
    // the sentence "nothing this lesson sends carries cache_control", which is
    // what kept `cache_creation_input_tokens` at zero on the way back. The
    // breakpoints go on in this lesson and the bound moves to
    // `cacheWrite1hMult` in the same commit, so what is pinned now is that they
    // are there and that the system head carries the 1h TTL.
    const req = buildRequest({
      ...base,
      // The branchy parts of the request, so the search covers the places a
      // breakpoint is actually written: the tool definitions and a multi-block
      // trailing user turn.
      tools: [{ name: 'search_hotels', input_schema: { type: 'object' } }],
      suffix: '## The notebook\n\n- destination: "Portugal"',
    })
    expect(everyKey(req)).toContain('cache_control')
    expect(req.system).toEqual([{
      type: 'text', text: 'You are the planning desk.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }])
    // And nothing was stamped onto the tool definitions, which render in front
    // of the system block and are already covered by the breakpoint on it.
    expect(everyKey(req.tools)).not.toContain('cache_control')
  })

  it('lands the suffix after the rolling breakpoint, never before it', () => {
    // The assertion that pins the ordering rather than the presence. A suffix
    // placed before the breakpoint would put the notebook inside the cached
    // prefix, so every fact she states would throw the cache away, which is the
    // failure this whole arrangement exists to avoid and it produces no error.
    const req = buildRequest({ ...base, suffix: '## The notebook' })
    const messages = req.messages as { content: { text?: string; cache_control?: unknown }[] }[]
    const last = messages.at(-1)!.content
    const markIndex = last.findIndex((b) => 'cache_control' in b)
    const suffixIndex = last.findIndex((b) => b.text === '## The notebook')
    expect(markIndex).toBeGreaterThanOrEqual(0)
    expect(suffixIndex).toBeGreaterThan(markIndex)
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
    //
    // Measured as each suffix's OWN contribution, against the same request with
    // no suffix at all, rather than as one total against twice the other. The
    // totals carry the request's fixed overhead, which grew in lesson 5.6 when
    // the system prompt became a block carrying a cache_control, and a
    // comparison of one total against twice another turns any fixed overhead
    // into a term on the wrong side. The deltas are the thing the claim is
    // about, and they do not move when the head does.
    const bare = estimateInputTokens(base)
    const ascii = estimateInputTokens({ ...base, suffix: 'a'.repeat(300) })
    const cjk = estimateInputTokens({ ...base, suffix: '葡'.repeat(300) })
    expect(cjk - bare).toBeGreaterThan((ascii - bare) * 2)
  })
})
