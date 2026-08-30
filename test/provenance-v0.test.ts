import { readFileSync } from 'node:fs'
import { HER_MESSAGE } from '../src/her.js'
import { handle } from '../src/router.js'
import { mockRunner } from '../src/tools.js'
import { offeredAmounts, quotedAmounts } from './helpers/provenance.js'
import { replayClient } from './model/replay.js'

describe('where the prices come from', () => {
  it('lesson one quoted prices that no tool returned', () => {
    const [exchange] = JSON.parse(readFileSync('test/fixtures/model/ask-portugal.json', 'utf8'))
    const text = exchange.response.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n')
    expect(quotedAmounts(text).length).toBeGreaterThan(0)
  })

  it('every price in the reply appears in a tool result of the same run', async () => {
    const client = replayClient('loop-portugal')
    const handled = await handle(HER_MESSAGE, client, mockRunner())
    client.done()
    expect(handled.toolTrace.length).toBeGreaterThan(0)
    const offered = offeredAmounts(handled.toolTrace)
    const quoted = quotedAmounts(handled.text)
    expect(quoted.length).toBeGreaterThan(0)
    for (const amount of quoted) {
      if (amount === 1500) continue
      expect(offered, `quoted ${amount}`).toContain(amount)
    }
  })
})
