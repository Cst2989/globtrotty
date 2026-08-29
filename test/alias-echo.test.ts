// What replaces this comparison is not built here: a behavioural check that
// replays a fixed prompt set on a schedule and alarms on the output
// distribution, rather than on the model string a response happens to echo.
import { readFileSync } from 'node:fs'
import { callAndRecord } from '../src/metered.js'
import { memorySink } from '../src/repo/model-calls.js'
import { SEATS, withSeat } from '../src/seats.js'
import { fakeClient, textMessage } from './model/fake.js'

type Exchange = { request: { model: string }; response: { model: string } }

function firstExchange(name: string): Exchange {
  return (JSON.parse(readFileSync(`test/fixtures/model/${name}.json`, 'utf8')) as Exchange[])[0]!
}

/**
 * The mitigation everyone reaches for first: record `response.model` and compare
 * it with what you sent, and a silent weights swap shows up as a mismatch.
 *
 * It cannot. The API echoes back exactly the string it was given. For an alias
 * like `claude-opus-5` that string is the same before and after the weights
 * behind it change, so every row reads identically and the detector never fires.
 * For a dated id the string is stable because the weights are, which is the only
 * case where the comparison means anything, and it is the case that did not need
 * a detector.
 */
describe('a model alias echoes itself', () => {
  it('returns the alias verbatim for the driver seat', () => {
    const exchange = firstExchange('ask-portugal')
    expect(exchange.request.model).toBe('claude-opus-5')
    expect(exchange.response.model).toBe(exchange.request.model)
  })

  it('returns the dated id verbatim for the cheap seat', () => {
    const exchange = firstExchange('classify-portugal')
    expect(exchange.request.model).toBe('claude-haiku-4-5-20251001')
    expect(exchange.response.model).toBe(exchange.request.model)
  })
})

/**
 * The two columns are not pointless, which is the other half of the argument.
 * They can hold different strings; the recorder does not compare them or fold
 * them into one. What the fixtures above show is that the API never puts a
 * different string in the second one, so the difference this column pair can
 * express is exactly the difference the provider never reports.
 */
describe('model_requested and model_returned are two facts', () => {
  it('records both strings separately when they disagree', async () => {
    const sink = memorySink()
    // A response that names a dated build rather than the alias that was sent.
    // The API does not do this today; the recorder handles it if it ever does.
    const client = fakeClient([textMessage('ok', { model: 'claude-opus-5-20260601' })])
    await callAndRecord(
      client,
      withSeat(SEATS.driver, {
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      { seat: SEATS.driver, promptVersion: 'p1', record: sink },
    )

    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.modelRequested).toBe('claude-opus-5')
    expect(sink.calls[0]!.modelReturned).toBe('claude-opus-5-20260601')
    expect(sink.calls[0]!.modelRequested).not.toBe(sink.calls[0]!.modelReturned)
  })

  it('records the same string twice when the API echoes, which is every real call', async () => {
    const sink = memorySink()
    const client = fakeClient([textMessage('ok', { model: 'claude-opus-5' })])
    await callAndRecord(
      client,
      withSeat(SEATS.driver, {
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      { seat: SEATS.driver, promptVersion: 'p1', record: sink },
    )

    // Equal strings, and equal is what the fixtures show for both seats. A
    // detector built on this comparison therefore fires never: not when the
    // weights behind the alias change, and not when they do not.
    expect(sink.calls[0]!.modelRequested).toBe(sink.calls[0]!.modelReturned)
  })
})
