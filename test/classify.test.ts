import { classify } from '../src/classify.js'
import { HER_MESSAGE } from '../src/her.js'
import { replayClient } from './model/replay.js'

export const VISA_QUESTION = 'Do I need a visa for Portugal with a German passport?'

describe('classify', () => {
  it('labels her Portugal request as a new trip', async () => {
    const client = replayClient('classify-portugal')
    const result = await classify(HER_MESSAGE, client)
    client.done()
    expect(result.label).toBe('new_trip')
  })
  it('labels a visa question as faq', async () => {
    const client = replayClient('classify-visa')
    const result = await classify(VISA_QUESTION, client)
    client.done()
    expect(result.label).toBe('faq')
  })
  it('turns a reply that is not a label into other', async () => {
    const client = { create: async () => ({ content: [{ type: 'text', text: 'maybe a trip?' }], model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: null } }) } as never
    const result = await classify('hello', client)
    expect(result.label).toBe('other')
  })
})
