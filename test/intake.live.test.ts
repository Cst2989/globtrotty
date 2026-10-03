// Opt-in live smoke test: hits the real Jev endpoint once with the Tokyo message. The recorded
// fixture (test/fixtures/jev/tokyo.json) proves assembleBrief's own logic against one frozen real
// response; this proves the request this module actually builds is still one Jev accepts and
// answers sensibly. Gated on LIVE_JEV so the default `pnpm test` run stays offline — same pattern
// as `test/supplier-kiwi.live.test.ts`.
import { describe, expect, it } from 'vitest'
import { runIntake } from '../src/intake/brief.js'

const live = process.env.LIVE_JEV === '1' ? describe : describe.skip

const MSG = 'I need to already be in Tokyo by the 20th of November, in time for a work conference that starts the moment I land that morning. I will fly out from Barcelona with my wife; book premium economy for the long flights, economy is fine for the short hop over to Kyoto for a couple of days. Sort out hotels for us too. We are back in Barcelona on Sunday the 6th of December.'
const today = new Date('2026-10-03T12:00:00Z')

function requireApiKey(): string {
  const apiKey = process.env.JEV_KEY
  if (!apiKey) throw new Error('LIVE_JEV=1 requires JEV_KEY to be set')
  return apiKey
}

live('runIntake (live)', () => {
  it('resolves the Tokyo message to a complete brief', async () => {
    const { outcome } = await runIntake({ jev: { apiKey: requireApiKey() } }, MSG, today, null)
    expect(outcome.kind).toBe('brief')
    if (outcome.kind !== 'brief') return
    expect(outcome.brief.destination).toBe('TYO')
    expect(outcome.brief.origin).toBe('BCN')
    expect(outcome.brief.adults).toBe(2)
    expect(outcome.brief.outbound).toBe('2026-11-19')
  })
})
