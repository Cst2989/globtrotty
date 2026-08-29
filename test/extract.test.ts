import { checkAgainstMessage, EMPTY_RAW, extract } from '../src/extract.js'
import { HER_MESSAGE } from '../src/her.js'
import { money } from '../src/money.js'
import { fakeClient, textMessage } from './model/fake.js'
import { replayClient } from './model/replay.js'

describe('checkAgainstMessage', () => {
  it('drops a budget the message never states', () => {
    const { kept, dropped } = checkAgainstMessage({ ...EMPTY_RAW, budget: { amount: 2000, currency: 'EUR' } }, HER_MESSAGE)
    expect(kept.budget).toBeNull()
    expect(dropped).toEqual(['budget'])
  })
  it('keeps 1500 when she wrote 1,500', () => {
    const { kept, dropped } = checkAgainstMessage({ ...EMPTY_RAW, budget: { amount: 1500, currency: 'EUR' } }, HER_MESSAGE)
    expect(kept.budget?.amount).toBe(1500)
    expect(dropped).toEqual([])
  })
  it('keeps seven nights for "a week"', () => {
    const { kept } = checkAgainstMessage({ ...EMPTY_RAW, nights: 7 }, HER_MESSAGE)
    expect(kept.nights).toBe(7)
  })
  it('drops a destination she never mentioned', () => {
    const { kept, dropped } = checkAgainstMessage({ ...EMPTY_RAW, destination: 'Spain' }, HER_MESSAGE)
    expect(kept.destination).toBeNull()
    expect(dropped).toEqual(['destination'])
  })
})

describe('extract', () => {
  it('reads her budget, party and wishes out of the Portugal message', async () => {
    const client = replayClient('extract-portugal')
    const result = await extract(HER_MESSAGE, client)
    client.done()
    expect(result.requirements.budget).toEqual(money(150000n, 'EUR'))
    expect(result.requirements.destination?.toLowerCase()).toContain('portugal')
    expect(result.requirements.partySize).toEqual({ adults: 2, children: 1, infants: 0 })
    expect(result.requirements.needsCrib).toBe(true)
    expect(result.requirements.nearBeach).toBe(true)
    expect(result.dropped).toEqual([])
  })
})

describe('extract, when the model answers with something that is not the schema', () => {
  it('falls back to empty requirements instead of throwing', async () => {
    const client = fakeClient([textMessage('I would love to help plan this trip!')])
    const result = await extract(HER_MESSAGE, client)
    expect(result.requirements).toEqual(EMPTY_RAW)
    expect(result.dropped).toEqual([])
  })
})
