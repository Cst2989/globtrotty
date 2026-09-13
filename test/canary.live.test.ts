import { liveClient } from '../src/client.js'
import { expectsCacheReads, SYSTEM_CACHE_TTL } from '../src/model/cache.js'
import { callModel, estimateInputTokens, type CallArgs } from '../src/model/client.js'
import { SEATS } from '../src/seats.js'
import { toolsForDesk } from '../src/tools/registry.js'
import { describeLiveModel, requireModelKey } from './helpers/live.js'

/**
 * The golden prompt. Fixed, checked in, and never regenerated: the whole value
 * of a canary is that the input has not moved, so a different answer is the
 * model moving and not the test moving.
 */
const GOLDEN = 'We are two adults and a toddler, Berlin to Faro, a week in September, '
  + 'about 1500 euros all in. Find us somewhere near the beach.'

/**
 * Her own budget figure, as she wrote it and in the forms a reply might echo it
 * in, removed from the prose before the no-price assertion runs.
 *
 * She said "about 1500 euros all in", so a reply that opens "got it, two adults
 * and a toddler, about 1500 euros all in" has stated no price: it has repeated
 * hers. Failing the canary on that is the same mistake as pinning one tool name,
 * a red light on a correct answer, and a canary that cries wolf is one somebody
 * turns off. What must still go red is a figure the model produced, which is any
 * amount that is not this one.
 */
const HER_BUDGET = /(?:€\s*)?\b1[.,]?500\b(?:\s*(?:eur|euros|€))?/gi

const goldenArgs = (): CallArgs => ({
  seat: SEATS.driver,
  system: 'You are the planning desk of a travel agency. Use the tools you have. '
    + 'Never state a price in prose.',
  messages: [{ role: 'user', content: [{ type: 'text', text: GOLDEN }] }],
  tools: toolsForDesk('planning'),
})

describeLiveModel('the drift canary', () => {
  it('answers a golden prompt the way it did when this was recorded', async () => {
    requireModelKey()
    // A fixed prompt with a checkable answer, sent at the seat's exact
    // configuration. What is asserted is not the wording, which drifts and
    // should, but the properties the desk depends on: that a tool is called,
    // that it is the right one, and that no price appears in the prose.
    const result = await callModel(liveClient(), goldenArgs(), Date.now)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.stopReason).toBe('tool_use')
    const calls = result.content.filter((b) => b.type === 'tool_use')
    // That it reached for a tool at all, and not for one NAMED tool. The first
    // recording of this canary asked for `search_hotels` and got
    // `update_requirements`, `ask_user` and `research_destination`: the golden
    // prompt says "a week in September" and does not say which week, so
    // recording what it was told and asking for the dates is a correct answer
    // and not drift. A canary that goes red on a correct answer is a canary
    // somebody switches off, and the property the desk actually depends on is
    // that the model works through the tools rather than answering in prose.
    expect(calls.length).toBeGreaterThan(0)
    // Every tool it reached for is one this desk actually has. A model that
    // invented a tool name is drift the harness would otherwise meet as a
    // rejection in production rather than as a red test here.
    const published = new Set(toolsForDesk('planning').map((t) => (t as { name: string }).name))
    for (const c of calls) expect(published.has((c as { name: string }).name)).toBe(true)
    // No price in the prose, which is the one property lesson 5.7's whole
    // channel split rests on the model NOT being trusted for. Asserted here so
    // that a drift in that direction is visible as a drift rather than only as
    // a redaction doing more work than it used to. Her own budget is struck out
    // first, for the reason `HER_BUDGET` above gives: echoing her number is not
    // quoting a price.
    const prose = result.content
      .filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ')
    expect(prose.replace(HER_BUDGET, '')).not.toMatch(/\d[\d.,]*\s*(?:eur|euros|€)|€\s*\d/i)
    // Pinned against the config id and not against the model string, because
    // the model string is the alias and cannot change. This assertion is what
    // makes the run attributable: a failure names the configuration that
    // produced it, and `group by model_config_id` separates the eras.
    expect(SEATS.driver.modelConfigId).toBe('claude-opus-5/high/16000')
  }, 120_000)

  it('reads a cached prefix on a second identical call', async () => {
    requireModelKey()
    // A per-seat expectation, because Haiku's minimum cacheable prefix is eight
    // times Opus's and a blanket assertion would pass for the driver and give
    // false confidence about the rest. A cache that silently stopped working
    // costs money and raises no error, so this is the only thing that would
    // notice.
    const client = liveClient()
    const first = await callModel(client, goldenArgs(), Date.now)
    // The same args object rebuilt, not reused, so the two requests are equal
    // by value and share a prefix rather than sharing an object.
    const second = await callModel(client, goldenArgs(), Date.now)
    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('ok')
    if (first.kind !== 'ok' || second.kind !== 'ok') return
    // The prefix is long enough for this seat to be cacheable at all, checked
    // before the read is asserted, so a prompt that shrank below the minimum
    // fails as "too short to cache" rather than as "caching is broken".
    expect(estimateInputTokens(goldenArgs())).toBeGreaterThan(512)
    // The WHOLE prompt, summed across the three input fields, and not
    // `input_tokens` on its own. `input_tokens` counts the tokens that were
    // neither written to nor read from the cache, so on a call that cached
    // successfully it is a small number, which is exactly the case this line
    // has to pass in: reading it alone would report "too short to cache" on
    // every working cache there is.
    const promptTokens = first.usage.input_tokens
      + first.usage.cache_creation_input_tokens + first.usage.cache_read_input_tokens
    expect(expectsCacheReads(SEATS.driver, promptTokens)).toBe(true)
    // The first call CACHED the prefix, by writing it or by finding it already
    // written. Not "wrote it": the head carries a one hour TTL, so a second run
    // of this file inside the hour finds the prefix warm and the first call
    // reports a read rather than a creation. An assertion on the creation count
    // alone passes once an hour and fails every other time, which is a canary
    // that teaches a reader to ignore it.
    expect(first.usage.cache_creation_input_tokens + first.usage.cache_read_input_tokens)
      .toBeGreaterThan(0)
    expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0)
    // And the TTL the head carried is the one the ledger will price it at.
    expect(SYSTEM_CACHE_TTL).toBe('1h')
  }, 120_000)
})
