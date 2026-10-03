import { describe, expect, it, vi } from 'vitest'
import {
  buildRequest, buildCountTokensRequest, estimateInputTokens, callModel, withSuffix,
  normalizeOperatorTurns,
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
    expect(req.output_config).toMatchObject({ effort: 'medium' })  // the driver's seat: Opus 5 medium
    expect(req.effort).toBeUndefined()          // effort is NOT a top-level field
  })

  it('omits effort entirely for a seat that takes none', () => {
    const req = buildRequest({ ...base, seat: SEATS.scout })
    const oc = (req.output_config ?? {}) as Record<string, unknown>
    expect(oc.effort).toBeUndefined()
  })

  it('sends no thinking block for a seat that takes no effort', () => {
    // Haiku 4.5 does not accept {type: 'adaptive'} and 400s on it.
    const req = buildRequest({ ...base, seat: SEATS.scout })
    expect(req.thinking).toBeUndefined()
    expect('thinking' in req).toBe(false)
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

  it('puts a JSON schema under output_config.format with type json_schema, and nowhere else', () => {
    const schema = { type: 'object', properties: { approved: { type: 'boolean' } },
                     required: ['approved'], additionalProperties: false }
    const req = buildRequest({ ...base, outputSchema: schema })
    expect(req.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema } })
    expect(req.output_format).toBeUndefined()          // the deprecated top-level name
  })

  it('emits no format when no schema is given, so the driver request is byte-identical to before', () => {
    const req = buildRequest(base)
    expect((req.output_config as Record<string, unknown>).format).toBeUndefined()
  })

  it('counts tokens for a structured request with the same format field', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false }
    const count = buildCountTokensRequest({ ...base, outputSchema: schema })
    expect((count.output_config as Record<string, unknown>).format).toEqual({ type: 'json_schema', schema })
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

  it('withSuffix appends to the LAST USER message even when a system message follows it', () => {
    const msgsWithAction: LoopMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'accept?' }] },
      { role: 'system', content: [{ type: 'text', text: 'Operator: …' }] },
    ]
    const out = withSuffix(msgsWithAction, 'NOTEBOOK')
    expect(out.at(-1)!.role).toBe('system')
    expect(out[2]!.content.at(-1)).toEqual({ type: 'text', text: 'NOTEBOOK' })
    expect(out).toHaveLength(4)
  })

  it('never produces a user turn after a system turn', () => {
    const req = buildRequest({
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [{ type: 'text', text: 'Operator: x' }] },
      ],
      suffix: 'NB',
    })
    const roles = (req.messages as LoopMessage[]).map((m) => m.role)
    expect(roles).toEqual(['user', 'system'])
  })

  // Plan 5 Task 8: `today` is prepended ahead of the notebook suffix, still
  // outside the cached prefix. Optional and defaulting to nothing sent, so
  // every fixture above — none of which passes `today` — is unaffected.
  it('prepends "Today is YYYY-MM-DD." ahead of the suffix', () => {
    const out = withSuffix(msgs, '## The notebook\n\n- destination: Faro', '2026-10-03')
    const last = out.at(-1)!.content.at(-1)!
    expect(last).toEqual({
      type: 'text',
      text: 'Today is 2026-10-03.\n\n## The notebook\n\n- destination: Faro',
    })
  })

  it('still opens a block for today alone, with no suffix to attach it to', () => {
    const out = withSuffix(msgs, undefined, '2026-10-03')
    expect(out.at(-1)!.content.at(-1)).toEqual({ type: 'text', text: 'Today is 2026-10-03.' })
  })

  it('with no `today`, sends exactly what it always sent', () => {
    expect(withSuffix(msgs, 'NOTEBOOK')).toEqual(withSuffix(msgs, 'NOTEBOOK', undefined))
  })

  it('threads through buildRequest via args.today', () => {
    const req = buildRequest({ ...base, suffix: '- destination: Faro', today: '2026-10-03' })
    const sent = req.messages as LoopMessage[]
    const last = sent.at(-1)!.content.at(-1)!
    expect(last).toEqual({ type: 'text', text: 'Today is 2026-10-03.\n\n- destination: Faro' })
  })
})

/**
 * Fix round 1 (plan 4a, Task 2 review, Critical). Ordinary row ordering can
 * hydrate `[…, system, user]` — a card action, then a typed message before
 * the agent replies — a `user` turn directly after `system` is a documented
 * 400. `withSuffix` alone cannot repair that shape (it only ever looks at a
 * TRAILING run); `normalizeOperatorTurns` fixes the whole transcript instead.
 *
 * Final review C1: it now runs LAST in `buildRequest`, after `withSuffix`,
 * which is what the Task 2 ruling said all along — "every system message
 * moves to immediately after the LAST user message (after the suffix)". The
 * cases below therefore pin where the operator message ends up once the
 * notebook is in place, not just where it ends up in the stored transcript.
 */
describe('normalizeOperatorTurns', () => {
  it('moves a system message from the middle to immediately after the LAST user message', () => {
    const out = normalizeOperatorTurns([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'Operator: x' }] },
      { role: 'user', content: [{ type: 'text', text: 'accept?' }] },
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system'])
    expect(out[2]!.content).toEqual([{ type: 'text', text: 'accept?' }])   // untouched otherwise
  })

  it('is followed by an assistant turn rather than trailing, when that is where the last user message sits', () => {
    // [user, assistant, system] → the last user is index 0, so the system
    // message moves to right after it; the assistant that followed it in the
    // original order stays after it too. This is still valid: a `system`
    // message must be the last entry OR be followed by an assistant turn, and
    // here it IS followed by one.
    const out = normalizeOperatorTurns([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'Operator: x' }] },
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
  })

  it('throws when a system message has no preceding user turn to anchor it to', () => {
    expect(() => normalizeOperatorTurns(
      [{ role: 'system', content: [{ type: 'text', text: 'Operator: x' }] }],
    )).toThrow('buildRequest: an operator message needs a preceding user turn')
  })

  it('merges two system messages into one, concatenating their content blocks in order', () => {
    const out = normalizeOperatorTurns([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'first' }] },
      { role: 'system', content: [{ type: 'text', text: 'second' }] },
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'system'])
    expect(out[1]!.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  })

  it('is a no-op when there is no system message at all', () => {
    expect(normalizeOperatorTurns(msgs)).toEqual(msgs)
  })

  it('through buildRequest: [user, assistant, system, user] + a suffix lands the suffix on the last user message', () => {
    const req = buildRequest({
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'system', content: [{ type: 'text', text: 'Operator: x' }] },
        { role: 'user', content: [{ type: 'text', text: 'accept?' }] },
      ],
      suffix: 'NOTEBOOK',
    })
    const sent = req.messages as LoopMessage[]
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system'])
    expect(sent[2]!.content.at(-1)).toEqual({ type: 'text', text: 'NOTEBOOK' })
  })

  it('through buildRequest: [user, assistant, system] + a suffix leaves the operator message LAST', () => {
    // The ordinary card path: she typed, the agent proposed, she pressed a
    // button. Final review C1 — normalise runs AFTER the suffix, so the
    // operator instruction is the last thing the model reads, not something
    // buried two turns back in front of the proposal it refers to.
    //
    // `withSuffix` sees a transcript whose non-`system` part ends on the
    // assistant, so the notebook does NOT join the stored user turn: it opens
    // a new user turn of its own (appending to an assistant turn would present
    // the notebook as something the model said). The operator message is then
    // lifted behind it.
    const req = buildRequest({
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a week in Portugal' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Here is your proposal' }] },
        { role: 'system', content: [{ type: 'text', text: 'Operator: … hand_off_to_booking' }] },
      ],
      suffix: 'NOTEBOOK',
    })
    const sent = req.messages as LoopMessage[]
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system'])
    expect(sent[2]!.content).toEqual([{ type: 'text', text: 'NOTEBOOK' }])
    expect(sent.at(-1)!.content).toEqual([{ type: 'text', text: 'Operator: … hand_off_to_booking' }])
  })

  it('through buildRequest: [user, assistant, system] with an empty suffix reorders to [user, system, assistant]', () => {
    const req = buildRequest({
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'system', content: [{ type: 'text', text: 'Operator: x' }] },
      ],
      suffix: '',
    })
    const sent = req.messages as LoopMessage[]
    expect(sent.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
  })

  it('through buildRequest: never caches the volatile suffix even with the new normalize step in the pipeline', () => {
    // Guards the invariant src/model/cache.ts documents: the rolling
    // breakpoint must never land on the notebook/suffix text, which changes
    // every turn. placeBreakpoints runs FIRST in the pipeline precisely so the
    // suffix block does not exist yet when the rolling block is picked — and
    // moving normalizeOperatorTurns to the END (final review C1) does not
    // change that, because it only moves `system` messages, which
    // placeBreakpoints skips wherever they sit.
    const req = buildRequest({ ...base, suffix: '- destination: Faro (user)' })
    const sent = req.messages as Array<{ content: Array<Record<string, unknown>> }>
    const blocks = sent.at(-1)!.content
    expect(blocks.at(-1)!.text).toBe('- destination: Faro (user)')
    expect(blocks.at(-1)!.cache_control).toBeUndefined()
  })
})

describe('buildRequest cache breakpoints', () => {
  it('puts the 1h system breakpoint on the request it will actually send', () => {
    const req = buildRequest(base)
    const system = req.system as Array<{ type: string; cache_control?: unknown }>
    expect(Array.isArray(system)).toBe(true)
    expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('sends volatile context AFTER the rolling breakpoint, never carrying it', () => {
    const req = buildRequest({ ...base, suffix: '- destination: Faro (user)' })
    const sent = req.messages as Array<{ content: Array<Record<string, unknown>> }>
    const blocks = sent.at(-1)!.content
    // The transcript block keeps the rolling breakpoint...
    expect(blocks.at(-2)!.cache_control).toEqual({ type: 'ephemeral' })
    // ...and the notebook sits behind it, uncached, because it changes every turn.
    expect(blocks.at(-1)!.text).toBe('- destination: Faro (user)')
    expect(blocks.at(-1)!.cache_control).toBeUndefined()
  })
})

describe('estimateInputTokens', () => {
  it('rounds a genuinely fractional byte count UP, not down', () => {
    // buildRequest({...base, system:'abcdefghij', messages:[], tools:[]}) stringifies
    // to 145 UTF-8 bytes (verified with Buffer.byteLength in `node -e` before
    // pinning this). 145 / 3 = 48.33..., so ceil (49) and floor (48) genuinely
    // disagree on this fixture — unlike a fixture that happens to divide evenly,
    // this one actually catches a flip to Math.floor. Same pattern as
    // test/spend.test.ts's "rounds a genuinely fractional pre-round value UP".
    // Task 6 note: buildRequest now wraps `system` in a cache_control-bearing
    // block (cacheableSystem), which adds fixed JSON overhead ahead of the
    // "abcdefghij" text — 145 bytes became 218. 218 / 3 = 72.66..., still
    // genuinely fractional, so ceil (73) and floor (72) still disagree; this
    // pinned value moved from 49 to 73 for that reason, not because the
    // ceil-vs-floor property this test checks changed.
    // Plan 5 Task 8 note: the driver's seat (`base.seat`) moved to
    // `claude-sonnet-5`/medium/4000 — three more bytes than `claude-opus-5`/
    // high/16000 in the serialized request (+2 for "sonnet" vs "opus", +2 for
    // "medium" vs "high", -1 for "4000" losing a digit against "16000") — so
    // 218 became 221. 221 / 3 = 73.66..., still genuinely fractional, so this
    // pinned value moved from 73 to 74 for that reason, not because the
    // ceil-vs-floor property this test checks changed.
    // Fix wave (C1) note: the seat reverted to `claude-opus-5`/medium/4000,
    // two bytes shorter than the Sonnet id, so this fixture fell to 219 — and
    // 219 / 3 = 73 EXACTLY, which would silently cost this test the only
    // property it checks (ceil and floor agreeing on 73). The fixture's system
    // string gained one character to restore the fraction: 220 / 3 = 73.33...,
    // so ceil (74) and floor (73) genuinely disagree again. The pinned value
    // stays 74; what moved is the input, deliberately.
    const one = estimateInputTokens({ ...base, system: 'abcdefghijk', messages: [], tools: [] })
    expect(one).toBe(74)
  })

  it('includes the suffix — excluding it is an unbounded undercount of a money reservation', () => {
    // Review round 1, CRITICAL 1: an earlier version of this function read
    // args.system/args.messages/args.tools directly and never looked at
    // args.suffix, so the notebook and memory (spec §7's volatile,
    // largest-in-the-prompt, uncached-behind-the-breakpoint context) contributed
    // exactly ZERO to the reservation meant to bound the call that sends them.
    // Measured before the fix: a 2,240-char notebook was 747 tokens excluded,
    // and that number only grows as the turn grows.
    const notebook = 'y'.repeat(2240)
    const withoutSuffix = estimateInputTokens(base)
    const withNotebook = estimateInputTokens({ ...base, suffix: notebook })
    expect(withNotebook).toBeGreaterThan(withoutSuffix + 700) // was +0 before the fix
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

  it('measures UTF-8 bytes, not UTF-16 code units — a code-unit formula undercounts CJK by ~3x', () => {
    // '旅' is 3 bytes in UTF-8 but 1 UTF-16 code unit — Node's String.length counts
    // code units. A `.length`-based formula (what an earlier version of this
    // function used, dividing by the same 3) sees the same "1 char" for a
    // byte-heavy CJK character as for an ASCII one, understating real token count
    // by close to 3x for CJK-heavy text once the fixed JSON boilerplate (which is
    // identical either way) is diluted by enough of it.
    const cjk = '旅'.repeat(1000)
    const byteBased = estimateInputTokens({ ...base, system: cjk, messages: [], tools: [] })
    // What a `.length`-based version would have produced for the same request,
    // computed the same way the reverted implementation did.
    const req = buildRequest({ ...base, system: cjk, messages: [], tools: [] })
    const codeUnitBased = Math.ceil(JSON.stringify(req).length / 3)
    // Task 6 note: buildRequest now wraps `system` in a cache_control-bearing
    // block, adding fixed JSON overhead present in BOTH the code-unit and
    // byte-based counts alike, so these two pinned values moved from 379/1045
    // to 403/1070. The ratio this test actually checks — byte-based well over
    // 2.5x code-unit-based for CJK-heavy text — is unaffected.
    // Plan 5 Task 8 note: the driver's seat moved to `claude-sonnet-5`/medium/
    // 4000 — three more bytes in the serialized request than `claude-opus-5`/
    // high/16000 (same accounting as estimateInputTokens's fractional-byte
    // test above), so these moved from 403/1070 to 404/1071. Fix wave (C1):
    // the seat reverted to `claude-opus-5`/medium/4000, two bytes shorter than
    // the Sonnet id, so 404/1071 became 403/1070.
    expect(codeUnitBased).toBe(403)  // verified with `node -e` before pinning
    expect(byteBased).toBe(1070)     // verified with Buffer.byteLength, same way
    expect(byteBased).toBeGreaterThan(codeUnitBased * 2.5)
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

  it('returns refused even when content is NON-EMPTY — a refusal can arrive after content was already generated', async () => {
    // Review round 1, IMPORTANT 2: the SDK documents stop_reason 'refusal' as
    // occurring "when streaming classifiers intervene to handle potential policy
    // violations" — a MID-STREAM intervention, which means content has often
    // already been generated by the time the refusal lands. content:[] alone is
    // not a strong enough fixture: an implementation that decided kind by
    // `content.length === 0` instead of by stop_reason would pass every OTHER
    // test in this file and still be wrong. This is the mutant that fixture
    // catches and the empty-content one does not.
    const transport = transportOf(() => ({
      content: [{ type: 'text', text: 'Here is how to make a to' }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      model: 'claude-opus-5', _request_id: 'req_3', usage,
    }))
    const r = await callModel(transport, base, () => 0)
    expect(r.kind).toBe('refused')
    if (r.kind !== 'refused') throw new Error('unreachable')
    expect(r.category).toBe('cyber')
    // The `refused` variant has no `content` field in its type at all — this
    // would not even compile if it did.
    expect('content' in r).toBe(false)
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

  it('throws rather than defaulting a missing stop_reason to a normal stop', async () => {
    // Review round 1, IMPORTANT 3: non-streaming responses guarantee stop_reason
    // is non-null. Its absence means the response shape was not what we expected
    // (a wrapped response, a `.withResponse()` object, a future SDK rename) — in
    // exactly that case, defaulting to 'end_turn' would turn a possibly-refused
    // response into a confident false success with empty content. That is the
    // precise catastrophe this module exists to prevent.
    const transport = transportOf(() => ({
      content: [{ type: 'text', text: 'x' }], model: 'claude-opus-5', usage,
      // stop_reason omitted entirely
    }))
    await expect(callModel(transport, base, () => 0)).rejects.toThrow(/stop_reason/)
  })

  it('throws rather than defaulting a missing usage to zero — a real call must not record as free', async () => {
    // IMPORTANT 4: `usage` is the one field on this response that is money.
    // `raw.usage ?? ZERO_USAGE` used to default a missing usage to all-zero
    // rather than throwing, the way the stop_reason guard above already did —
    // and a zero-usage 'ok' result prices at 0n, so `reconcile` would refund
    // the WHOLE reservation and a real, billed call would be recorded as free.
    const transport = transportOf(() => ({
      content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', model: 'claude-opus-5',
      // usage omitted entirely
    }))
    await expect(callModel(transport, base, () => 0)).rejects.toThrow(/usage/)
  })

  it('still classifies a genuine refusal correctly when usage IS present', async () => {
    // Guards against the usage check being placed so early it starts
    // rejecting real refusals: the SDK always returns `usage` on a refusal,
    // so this must reach the 'refused' branch, not throw.
    const transport = transportOf(() => ({
      content: [], stop_reason: 'refusal',
      stop_details: { category: 'cyber', explanation: null },
      model: 'claude-opus-5', usage,
    }))
    const r = await callModel(transport, base, () => 0)
    expect(r.kind).toBe('refused')
    expect(r.usage).toEqual(usage)
  })

  it('passes the AbortSignal through to the transport, so an abort actually aborts', async () => {
    // Review round 1, IMPORTANT 6: `signal` was accepted on CallArgs and never
    // reached the transport, so an aborted turn kept burning tokens and
    // classifyError's APIUserAbortError branch could never fire from this path.
    const controller = new AbortController()
    const create = vi.fn().mockResolvedValue({
      content: [], stop_reason: 'end_turn', model: 'claude-opus-5', usage,
    })
    await callModel({ create }, { ...base, signal: controller.signal }, () => 0)
    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
  })
})
