// Opt-in live smoke test: hits the real Anthropic API once. Every other test in
// this repo runs against a stubbed transport — that proves the parser handles
// whatever shape we hand it, but not that the request shape we build is still
// one the real API accepts. `budget_tokens` still exists in the SDK's
// TypeScript types even though sending it returns a 400 on Opus 5, so `tsc` is
// blind to that whole class of drift. Gated on LIVE_MODEL so the default
// `pnpm test` run stays offline — same pattern as `test/supplier-kiwi.live.test.ts`.
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { callModel } from '../src/model/client.js'
import { SEATS } from '../src/model/seats.js'
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
})
