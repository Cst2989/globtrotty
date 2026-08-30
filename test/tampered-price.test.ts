import { ProposalRefsSchema } from '../src/gates/rehydrateGate.js'
import { HER_MESSAGE } from '../src/her.js'
import { formatMoney, money } from '../src/money.js'
import { handle } from '../src/router.js'
import { mockRunner } from '../src/tools.js'
import { offeredAmounts, quotedAmounts } from './helpers/provenance.js'
import { replayClient } from './model/replay.js'

type WireOffer = { sourceId: string; name: string; price: { minor: string; currency: string } }

/**
 * The article's `checkProvenance`, reproduced here rather than imported,
 * because it is the version this lesson replaces and this demonstration has to
 * keep working afterwards. Same shape as module 3's trick of writing tier 3's
 * old body out in raw SQL: the point of a reproduced defect is that it stays
 * reproducible.
 *
 * It validates that a sourceId was SEEN. It never looks at the values attached
 * to it, which is the whole of the flaw.
 */
function citesOnlySeenIds(offer: { sourceId: string }[], trace: { content: string; isError: boolean }[]): boolean {
  const seen = new Set<string>()
  for (const entry of trace) {
    if (entry.isError) continue
    for (const item of JSON.parse(entry.content) as WireOffer[]) seen.add(item.sourceId)
  }
  return offer.every((item) => seen.has(item.sourceId))
}

describe('the provenance check lesson 1.4 shipped', () => {
  it('passes an offer that moved one hotel\'s price onto another hotel', async () => {
    const client = replayClient('loop-portugal')
    const handled = await handle(HER_MESSAGE, client, mockRunner())
    client.done()

    const hotels = handled.toolTrace
      .filter((t) => !t.isError && t.name === 'search_hotels')
      .flatMap((t) => JSON.parse(t.content) as WireOffer[])
    const cited = hotels[0]!
    const other = hotels.find((h) => h.price.minor !== cited.price.minor)!
    expect(cited.sourceId).not.toBe(other.sourceId)

    // A reply naming a real hotel, by its real id, at another real hotel's real
    // price. Nothing here was hallucinated. Everything here is wrong.
    const reply =
      `I recommend ${cited.name} (${cited.sourceId}) at `
    + `${formatMoney(money(BigInt(other.price.minor), other.price.currency))} for the week.`

    // Both halves of lesson 1.4's check say yes.
    expect(citesOnlySeenIds([{ sourceId: cited.sourceId }], handled.toolTrace)).toBe(true)
    const offered = offeredAmounts(handled.toolTrace)
    const quoted = quotedAmounts(reply)
    expect(quoted).toHaveLength(1)
    for (const amount of quoted) expect(offered).toContain(amount)

    // And the number she reads is not the number that item costs.
    expect(Number(cited.price.minor) / 100).not.toBe(quoted[0])
  })

  it('passes an offer whose price was invented, because the check reads prose', async () => {
    const client = replayClient('loop-portugal')
    const handled = await handle(HER_MESSAGE, client, mockRunner())
    client.done()
    const hotels = handled.toolTrace
      .filter((t) => !t.isError && t.name === 'search_hotels')
      .flatMap((t) => JSON.parse(t.content) as WireOffer[])

    // An offer sent as data, with a price nothing quoted. This is the shape a
    // structured offer takes, and it is the shape lesson 4.5's gates need.
    const offer = [{ sourceId: hotels[0]!.sourceId, price: 8900, currency: 'EUR' }]

    expect(citesOnlySeenIds(offer, handled.toolTrace)).toBe(true)
    // 8900 was never quoted by anything.
    expect(offeredAmounts(handled.toolTrace)).not.toContain(8900)
    // And the amount check never sees it, because it scans a reply for text
    // that looks like money and this offer is a JSON object in a tool call.
    expect(quotedAmounts(JSON.stringify(offer))).toEqual([])
  })
})

describe('the same two offers, against the rehydration gate', () => {
  it('cannot express the swap at all, because there is no price to move', () => {
    // The first case's offer, written as the model now has to write it.
    const asRefs = ProposalRefsSchema.safeParse({
      refs: [{ sourceId: 'hotel-0-4188', quantity: 1, slot: 'stay' }],
    })
    expect(asRefs.success).toBe(true)
    // And there is nowhere in that object for the other hotel's price to go.
    expect(Object.keys(asRefs.success ? asRefs.data.refs[0]! : {}).sort())
      .toEqual(['quantity', 'slot', 'sourceId'])
  })

  it('rejects the invented price at the boundary rather than ignoring it', () => {
    const r = ProposalRefsSchema.safeParse({
      refs: [{ sourceId: 'hotel-0-4188', quantity: 1, slot: 'stay', price: 8900, currency: 'EUR' }],
    })
    expect(r.success).toBe(false)
    // Rejected, not silently dropped. Ignoring the key would work and would
    // hide the fact that the model tried, which is a signal worth having.
    const keys = r.success ? [] : r.error.issues.flatMap((i) => (i as { keys?: string[] }).keys ?? [])
    expect(keys).toContain('price')
  })
})
