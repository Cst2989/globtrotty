import { readFileSync } from 'node:fs'
import { HER_MESSAGE } from '../src/her.js'
import { handle } from '../src/router.js'
import { MockSupplier, type Offer } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { replayClient } from './model/replay.js'

/** Every amount in a reply that reads like money: "310 USD", "€420", "1,500 euros". */
export function quotedAmounts(text: string): number[] {
  const amounts: number[] = []
  for (const match of text.matchAll(/(?:€|\$|USD|EUR)\s?(\d[\d,]*)|(\d[\d,]*)\s?(?:€|\$|USD|EUR|euros|dollars)/gi)) {
    const raw = match[1] ?? match[2]
    if (raw) amounts.push(Number(raw.replace(/,/g, '')))
  }
  return amounts
}

function offeredAmounts(trace: { content: string; isError: boolean }[]): Set<number> {
  const amounts = new Set<number>()
  for (const entry of trace) {
    if (entry.isError) continue
    for (const offer of JSON.parse(entry.content) as Offer[]) amounts.add(offer.price.amount)
  }
  return amounts
}

describe('where the prices come from', () => {
  it('lesson one quoted prices that no tool returned', () => {
    const [exchange] = JSON.parse(readFileSync('test/fixtures/model/ask-portugal.json', 'utf8'))
    const text = exchange.response.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n')
    expect(quotedAmounts(text).length).toBeGreaterThan(0)
  })

  it('every price in the reply appears in a tool result of the same run', async () => {
    const client = replayClient('loop-portugal')
    const handled = await handle(HER_MESSAGE, client, mockRunner(new MockSupplier()))
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
