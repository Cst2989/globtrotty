import { ask } from '../src/ask.js'
import { handle } from '../src/router.js'
import { SEATS } from '../src/seats.js'
import { dollars } from '../src/pricing.js'
import { VISA_QUESTION } from './classify.test.js'
import { replayClient } from './model/replay.js'

describe('the cheap seat', () => {
  it('answers the visa question for less than the driver would', async () => {
    const cheap = replayClient('faq-visa-cheap')
    const routed = await handle(VISA_QUESTION, cheap)
    cheap.done()
    const opus = replayClient('ask-visa-opus')
    const direct = await ask(VISA_QUESTION, opus, SEATS.driver)
    opus.done()
    console.log(`visa question: routed ${dollars(routed.costMicros)}, driver alone ${dollars(direct.costMicros)}`)
    expect(routed.label).toBe('faq')
    expect(routed.costMicros).toBeLessThan(direct.costMicros)
  })
})
