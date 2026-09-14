// Opt-in live smoke test: hits the real Anthropic API once. Every other test in
// this repo runs against a stubbed transport — that proves the parser handles
// whatever shape we hand it, but not that the request shape we build is still
// one the real API accepts. `budget_tokens` still exists in the SDK's
// TypeScript types even though sending it returns a 400 on Opus 5, so `tsc` is
// blind to that whole class of drift. Gated on LIVE_MODEL so the default
// `pnpm test` run stays offline — same pattern as `test/supplier-kiwi.live.test.ts`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { buildRequest, callModel } from '../src/model/client.js'
import { SEATS } from '../src/model/seats.js'
import { FRONT_SCHEMA } from '../src/agents/frontDesk.js'
import { WEB_SEARCH_TOOL } from '../src/agents/scout.js'
import { renderNotebook } from '../src/repo/notebook.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'

// L1: read the real prompt files exactly as the agents themselves do
// (src/agents/frontDesk.ts, src/agents/scout.ts) rather than a hand-written
// stand-in — a live pin that sends a DIFFERENT prompt than production proves
// nothing about whether production's actual request shape is still accepted.
const FRONT_DESK_SYSTEM = readFileSync(new URL('../src/agents/prompts/front_desk.md', import.meta.url), 'utf8')
const SCOUT_SYSTEM = readFileSync(new URL('../src/agents/prompts/scout.md', import.meta.url), 'utf8')
// Not called in the two assertions below — no single live call here is large
// enough, or repeated enough, to reliably exercise a cache read. Imported
// anyway, per the task brief's exact test file, as the reference to why this
// file does NOT assert a blanket "cache_read_input_tokens > 0": that figure is
// per-seat and per-prompt-size (see its doc comment in src/model/cache.ts), and
// the two tests below stick to assertions that hold regardless.
import { expectsCacheReads } from '../src/model/cache.js'

const live = process.env.LIVE_MODEL === '1' ? describe : describe.skip

// Nothing that can throw may sit in the describe factory: vitest runs it during
// collection even when skipped, so a throw here breaks the offline default run.
function transport() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || key.startsWith('placeholder')) {
    throw new Error('LIVE_MODEL=1 requires a real ANTHROPIC_API_KEY')
  }
  const c = new Anthropic({ apiKey: key })
  return {
    create: (req: unknown) => c.messages.create(req as never) as Promise<unknown>,
    countTokens: (req: unknown) =>
      c.messages.countTokens(req as never) as Promise<{ input_tokens: number }>,
  }
}

live('driver against the real API', () => {
  it('accepts the request shape we build — no 400 on thinking, effort, or tools', async () => {
    const r = await callModel(
      transport(),
      { seat: SEATS.driver, system: 'Answer in exactly one short sentence.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Name one city in Portugal.' }] }],
        tools: [] },
      () => Date.now(),
    )
    // Assert SHAPE, not content — the model's words will vary.
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error(`refused: ${r.explanation}`)
    expect(r.usage.input_tokens).toBeGreaterThan(0)
    expect(r.usage.output_tokens).toBeGreaterThan(0)
    expect(r.content.some((b) => b.type === 'text')).toBe(true)
  }, 120_000)

  it('returns the exact model id we pinned, which is why drift needs a canary', async () => {
    const r = await callModel(
      transport(),
      { seat: SEATS.driver, system: 'Reply with the word ok.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }], tools: [] },
      () => Date.now(),
    )
    if (r.kind !== 'ok') throw new Error('refused')
    // `claude-opus-5` is a DATELESS canonical id — there is no dated form for it
    // to resolve to — so it comes back verbatim and a string comparison detects
    // nothing across a weights change. (A genuine alias like `claude-haiku-4-5`
    // WOULD resolve to a dated snapshot, which is why Task 2 pins the dated
    // Haiku.) If this ever returns a dated id, the drift strategy can be
    // revisited, and this test is where we would find out.
    expect(r.model).toBe('claude-opus-5')
  }, 120_000)

  it('the API accepts output_config.format and returns parseable JSON for the reviewer schema', async () => {
    const client = new Anthropic()
    const schema = { type: 'object', properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
                     required: ['approved', 'issues'], additionalProperties: false }
    const req = buildRequest({
      seat: SEATS.reviewer, system: 'Answer in the schema.', tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Approve this: a flight for €100.' }] }],
      outputSchema: schema,
    })
    const res = await client.messages.create(req as never)
    const text = res.content.find((b) => b.type === 'text')
    expect(text).toBeDefined()
    const parsed = JSON.parse((text as { text: string }).text)
    expect(typeof parsed.approved).toBe('boolean')
    expect(Array.isArray(parsed.issues)).toBe(true)
  }, 60_000)
})

// Task 9's canary pins: one live call per Haiku seat, proving against the real
// API exactly the two things the driver's live tests above prove for Opus —
// "no thinking block on Haiku" (src/model/client.ts's `buildRequest` doc
// comment) and the server tool's real response shape — rather than trusting a
// stubbed transport for either.
live('Haiku seats against the real API', () => {
  it('front_desk: no thinking block, structured output for FRONT_SCHEMA', async () => {
    const r = await callModel(
      transport(),
      {
        seat: SEATS.front_desk, tools: [],
        system: FRONT_DESK_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a week in Portugal in September for two' }] }],
        outputSchema: FRONT_SCHEMA,
      },
      () => Date.now(),
    )
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error(`refused: ${r.explanation}`)
    const text = r.content.find((b) => b.type === 'text')
    expect(text).toBeDefined()
    const parsed = JSON.parse((text as { type: 'text'; text: string }).text)
    expect(['new_trip', 'faq', 'unclear']).toContain(parsed.label)
  }, 60_000)

  it('scout: accepts the server-side web_search tool, sends the notebook suffix, and actually searches', async () => {
    // A non-empty notebook — the real prompt talks about "this party" and
    // "their month", so a pin that sends none of that is not exercising the
    // shape production actually sends (src/agents/scout.ts's `suffix`).
    const notebook: Notebook = {
      ...emptyNotebook(),
      partySize: { value: { adults: 2, children: 0, infants: 0 }, source: 'user', at: new Date().toISOString() },
      departureDate: { value: '2026-09-12', source: 'user', at: new Date().toISOString() },
    }
    const r = await callModel(
      transport(),
      {
        seat: SEATS.scout, tools: [WEB_SEARCH_TOOL],
        system: SCOUT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'City: Faro' }] }],
        suffix: renderNotebook(notebook),
      },
      () => Date.now(),
    )
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error(`refused: ${r.explanation}`)
    expect(typeof r.usage.server_tool_use?.web_search_requests).toBe('number')
    // L1: the golden city (Faro) should provoke at least one real search — a
    // brief with zero searches proves nothing about the tool actually firing.
    // If this turns out flaky against the live API (the model answers from
    // its own knowledge without searching), loosen to `>= 0` and say so in
    // the report rather than silently deleting the assertion.
    expect(r.usage.server_tool_use!.web_search_requests).toBeGreaterThanOrEqual(1)
    expect(r.content.some((b) => (b as { type: string }).type === 'web_search_tool_result')).toBe(true)
  }, 60_000)
})
