import { describe, expect, it, vi } from 'vitest'
import {
  buildRequest, buildCountTokensRequest, estimateInputTokens, callModel,
} from '../src/model/client.js'
import { SEATS } from '../src/model/seats.js'
import type { LoopMessage } from '../src/engine.js'

const msgs: LoopMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
const base = { seat: SEATS.driver, system: 'You are a travel agent.', messages: msgs, tools: [] }

const usage = {
  input_tokens: 10, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: 5,
}
const transportOf = (impl: () => unknown) => ({ create: vi.fn().mockImplementation(impl) })

describe('buildRequest', () => {
  it('never sends budget_tokens — it is removed on Opus 5 and returns 400', () => {
    // The SDK's thinking union still ACCEPTS {type:'enabled', budget_tokens},
    // so tsc cannot catch this. This assertion is the only guard.
    expect(JSON.stringify(buildRequest(base))).not.toContain('budget_tokens')
  })

  it('sends adaptive thinking and effort inside output_config, not top level', () => {
    const req = buildRequest(base)
    expect(req.thinking).toEqual({ type: 'adaptive' })
    expect(req.output_config).toMatchObject({ effort: 'high' })
    expect(req.effort).toBeUndefined()          // effort is NOT a top-level field
  })

  it('omits effort entirely for a seat that takes none', () => {
    const req = buildRequest({ ...base, seat: SEATS.scout })
    const oc = (req.output_config ?? {}) as Record<string, unknown>
    expect(oc.effort).toBeUndefined()
  })

  it('never prefills an assistant turn — it returns 400 on Opus 5', () => {
    const sent = buildRequest(base).messages as LoopMessage[]
    expect(sent.at(-1)!.role).toBe('user')
  })

  it('pins the seat model and max_tokens onto the request', () => {
    const req = buildRequest(base)
    expect(req.model).toBe('claude-opus-5')
    expect(req.max_tokens).toBe(SEATS.driver.maxTokens)
  })
})

describe('buildCountTokensRequest', () => {
  it('drops max_tokens — count_tokens is not being asked to produce output', () => {
    const req = buildCountTokensRequest(base)
    expect(req.max_tokens).toBeUndefined()
    expect('max_tokens' in req).toBe(false)
  })

  it('counts the SAME prompt that will be sent, field for field', () => {
    // Derived from buildRequest rather than assembled separately: a reservation
    // computed from a different prompt than the one dispatched is not a bound.
    const send = buildRequest(base)
    const count = buildCountTokensRequest(base)
    expect(count.model).toEqual(send.model)
    expect(count.system).toEqual(send.system)
    expect(count.messages).toEqual(send.messages)
    expect(count.thinking).toEqual(send.thinking)
    expect(count.output_config).toEqual(send.output_config)
  })
})

describe('buildRequest suffix', () => {
  it('puts volatile context after the last block of the last user turn', () => {
    const req = buildRequest({ ...base, suffix: '## The notebook\n\n- destination: Faro' })
    const sent = req.messages as LoopMessage[]
    expect(sent).toHaveLength(1)                     // no extra turn was invented
    const last = sent.at(-1)!.content.at(-1)!
    expect(last).toEqual({ type: 'text', text: '## The notebook\n\n- destination: Faro' })
  })

  it('opens a new user turn when the transcript ends on the assistant', () => {
    // Appending a block to an assistant turn would make the notebook read as
    // something the MODEL said, and a bare push would leave the request ending
    // on an assistant turn — a prefill, which is a 400.
    const req = buildRequest({
      ...base,
      messages: [...msgs, { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] }],
      suffix: 'notebook',
    })
    const sent = req.messages as LoopMessage[]
    expect(sent).toHaveLength(3)
    expect(sent.at(-1)!.role).toBe('user')
    expect(sent.at(-1)!.content).toEqual([{ type: 'text', text: 'notebook' }])
  })

  it('changes nothing when there is no volatile context to send', () => {
    expect(buildRequest(base).messages).toEqual(buildRequest({ ...base, suffix: '' }).messages)
  })
})

describe('estimateInputTokens', () => {
  it('rounds UP — an under-estimate under-reserves', () => {
    // 3 chars/token, deliberately below the ~3.5-4 English average, and ceil'd:
    // over-reserving costs a refund at reconcile, under-reserving lifts the
    // ceiling for the call it was supposed to bound.
    const one = estimateInputTokens({ ...base, system: 'abcdefghij', messages: [], tools: [] })
    expect(one).toBe(4)                       // ceil(10 / 3), not 3
  })

  it('grows with the transcript and the tools, not just the system prompt', () => {
    const small = estimateInputTokens({ ...base, tools: [] })
    const big = estimateInputTokens({
      ...base,
      messages: [...msgs, { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600) }] }],
      tools: [{ name: 'explore_flights', description: 'y'.repeat(300) }],
    })
    expect(big).toBeGreaterThan(small + 250)
  })

  it('never returns zero for a non-empty prompt', () => {
    expect(estimateInputTokens({ ...base, system: 'a', messages: [], tools: [] }))
      .toBeGreaterThan(0)
  })
})

describe('callModel', () => {
  it('returns ok with content and usage on a normal stop', async () => {
    const transport = transportOf(() => ({
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'req_1', usage,
    }))
    let t = 1000
    const r = await callModel(transport, base, () => (t += 250))
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(r.stopReason).toBe('end_turn')
    expect(r.requestId).toBe('req_1')
    expect(r.usage.output_tokens).toBe(5)
    expect(r.latencyMs).toBeGreaterThan(0)
    expect(transport.create).toHaveBeenCalledTimes(1)
  })

  it('returns refused on stop_reason refusal, WITHOUT reading content', async () => {
    // The whole point: this is an HTTP 200 that does not throw, and content is
    // empty. A client that read content first would return an empty success.
    const transport = transportOf(() => ({
      content: [], stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      model: 'claude-opus-5', _request_id: 'req_2', usage,
    }))
    const r = await callModel(transport, base, () => 0)
    expect(r.kind).toBe('refused')
    if (r.kind !== 'refused') throw new Error('unreachable')
    expect(r.category).toBe('cyber')
    expect(r.explanation).toBe('no')
    // Usage is still reported: the caller records what the provider said rather
    // than assuming zero. What it does about quota is Task 10's decision.
    expect(r.usage).toEqual(usage)
  })

  it('treats a refusal with no stop_details as a refusal with a null category', async () => {
    const transport = transportOf(() => ({
      content: [], stop_reason: 'refusal', model: 'claude-opus-5', usage,
    }))
    const r = await callModel(transport, base, () => 0)
    expect(r.kind).toBe('refused')
    if (r.kind !== 'refused') throw new Error('unreachable')
    expect(r.category).toBeNull()
  })

  it('surfaces max_tokens as ok — it is a truncation, not a refusal', async () => {
    const transport = transportOf(() => ({
      content: [{ type: 'text', text: 'trunc' }], stop_reason: 'max_tokens',
      model: 'claude-opus-5', usage,
    }))
    const r = await callModel(transport, base, () => 0)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.stopReason).toBe('max_tokens')
  })

  it('does not swallow a transport error — the classifier handles it upstream', async () => {
    const transport = { create: vi.fn().mockRejectedValue(new Error('connection reset')) }
    await expect(callModel(transport, base, () => 0)).rejects.toThrow(/connection reset/)
  })
})
