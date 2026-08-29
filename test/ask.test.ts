import { ask, MODEL } from '../src/ask.js'
import { HER_MESSAGE } from '../src/her.js'
import { replayClient } from './model/replay.js'

describe('ask', () => {
  it('answers her message and prices the call', async () => {
    const client = replayClient('ask-portugal')
    const answer = await ask(HER_MESSAGE, client)
    client.done()
    expect(answer.text.length).toBeGreaterThan(200)
    expect(answer.model.startsWith(MODEL)).toBe(true)
    expect(answer.usage.input_tokens).toBeGreaterThan(0)
    expect(answer.costMicros).toBeGreaterThan(0n)
  })
})
