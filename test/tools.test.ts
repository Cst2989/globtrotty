import { ProposalRefsSchema } from '../src/gates/rehydrateGate.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import { UnusableResponseError, type Supplier } from '../src/supplier/types.js'
import { itemForModel, mockRunner, TOOLS } from '../src/tools.js'

describe('tools', () => {
  const run = mockRunner()
  it('describes every tool with a JSON schema the API accepts', () => {
    // Literal, and it grows with the product: `propose_itinerary` joined in
    // lesson 4.5 and `hand_off_to_booking` in lesson 4.6. A list derived from
    // TOOLS would assert only that TOOLS equals itself, and this is the one
    // place a tool added by accident is caught.
    expect(TOOLS.map((t) => t.name))
      .toEqual(['search_flights', 'search_hotels', 'propose_itinerary', 'hand_off_to_booking'])
    for (const tool of TOOLS) expect(tool.input_schema.type).toBe('object')
  })
  it('publishes the quantity bounds the gate boundary actually enforces', () => {
    // The published schema is documentation and `ProposalRefsSchema`
    // (src/gates/rehydrateGate.ts) is the boundary that decides, so the two
    // are two declarations of one shape and they have to agree on the bounds.
    // A model reading a wider bound than the boundary keeps sends a quantity
    // the boundary refuses structurally, and a structural refusal is a
    // provenance violation carrying no source ids: the reply cannot name the
    // item that was wrong. Published, it is a value the model never sends.
    const propose = TOOLS.find((t) => t.name === 'propose_itinerary')!
    const props = propose.input_schema.properties as {
      refs: { items: { properties: Record<string, Record<string, unknown>> } }
    }
    const quantity = props.refs.items.properties.quantity!
    expect(quantity.exclusiveMinimum).toBe(0)
    expect(quantity.maximum).toBe(16)
    // The boundary's own verdict on the two edges and on the largest value it
    // still calls well formed, so this pins agreement rather than two numbers.
    const proposal = (q: number) => ({ refs: [{ sourceId: 'flight-0-1', quantity: q, slot: 'flight' }] })
    expect(ProposalRefsSchema.safeParse(proposal(0)).success).toBe(false)
    expect(ProposalRefsSchema.safeParse(proposal(17)).success).toBe(false)
    expect(ProposalRefsSchema.safeParse(proposal(16)).success).toBe(true)
  })
  it('returns offers as JSON', async () => {
    // 's0-b0' is a call id: mockRunner forwards it to a runner that ignores
    // it, but calling a value typed as ToolRunner needs all three arguments
    // regardless (src/tools.ts).
    const outcome = await run('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 }, 's0-b0')
    expect(outcome.isError).toBe(false)
    expect(JSON.parse(outcome.content)).toHaveLength(3)
  })
  it('turns a bad input into an error result instead of a crash', async () => {
    const outcome = await run('search_flights', { from: 'BER' }, 's0-b0')
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('Invalid input')
  })
  it('describes a supplier outage as a supplier outage, not as a bad input', async () => {
    // A model that is told its input was invalid will rewrite its input. A
    // model that is told the supplier failed will try again or route around it.
    // Reporting the second as the first sends it off fixing a correct request.
    const down: Supplier = {
      name: 'kiwi',
      kind: 'flight',
      capabilities: { live: true, mayRequote: true, maxAgeSeconds: 900, pricePersistence: 'session' },
      search: async () => { throw new Error('kiwi: HTTP 503') },
      quote: async () => ({ status: 'gone' }),
    }
    const outcome = await mockRunner({ ...mockSuppliers(), flight: down })(
      'search_flights',
      { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: null, adults: 2, children: 1 },
      's0-b0',
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('HTTP 503')
    expect(outcome.content).not.toContain('Invalid input')
  })
  /**
   * The third failure, and the one the whole-branch review named. Kiwi refuses
   * a whole frame over one fare priced at or below zero
   * (`parseKiwiResponse`, src/supplier/kiwi.ts), which is deliberate and is
   * pinned in test/supplier-kiwi.test.ts. What was wrong was the sentence: the
   * model was told "kiwi search failed", which is what it is told when the
   * supplier is down, so it re-issued the identical call, got the identical
   * throw, and spent its step budget doing it. The supplier is up and the
   * answer is the thing that was refused, and those are different next moves.
   */
  it('describes a refused response as a refusal, not as an outage', async () => {
    const nonsense: Supplier = {
      name: 'kiwi',
      kind: 'flight',
      capabilities: { live: true, mayRequote: true, maxAgeSeconds: 900, pricePersistence: 'session' },
      search: async () => { throw new UnusableResponseError('kiwi: unusable price 0 on it-3') },
      quote: async () => ({ status: 'gone' }),
    }
    const outcome = await mockRunner({ ...mockSuppliers(), flight: nonsense })(
      'search_flights',
      { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: null, adults: 2, children: 1 },
      's0-b0',
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('unusable price 0 on it-3')
    expect(outcome.content).toContain('refused')
    expect(outcome.content).toContain('The supplier is up')
    // The two words that send it back around the same loop.
    expect(outcome.content).not.toContain('search failed')
    expect(outcome.content).not.toContain('Invalid input')
  })
  /**
   * One case per date field the tools publish. A malformed hotel date used to
   * reach `nightsBetween` inside the supplier and come back as `mock search
   * failed`, which tells the model the thing it should try again, so it
   * re-issues the same broken date forever, and a malformed flight date came
   * back as an itinerary built out of the typo. The schema now refuses both at
   * the seam
   * (`src/tools.ts`), and the assertion that matters is the negative one: this
   * must never be described as an outage.
   */
  it.each([
    ['search_flights', 'departureDate',
      { from: 'BER', to: 'LIS', departureDate: 'September 19', returnDate: null, adults: 2, children: 1 }],
    ['search_flights', 'returnDate',
      { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: '25/09/2026', adults: 2, children: 1 }],
    ['search_hotels', 'checkIn',
      { city: 'Lagos', checkIn: 'next Friday', checkOut: '2026-09-25', adults: 2, children: 1 }],
    ['search_hotels', 'checkOut',
      { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-9-25', adults: 2, children: 1 }],
  ])('tells the model a malformed %s.%s is its own bad input, not an outage', async (tool, _field, input) => {
    const outcome = await run(tool, input, 's0-b0')
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('Invalid input')
    expect(outcome.content).not.toContain('search failed')
    expect(outcome.content).not.toContain('bad ISO date')
  })

  it('accepts a null returnDate, which is a one-way search and not a bad date', async () => {
    const outcome = await run(
      'search_flights',
      { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: null, adults: 2, children: 1 },
      's0-b0',
    )
    expect(outcome.isError).toBe(false)
  })

  it('never puts a supplier-supplied URL on the wire', async () => {
    const [item] = await mockSuppliers().hotel.search({
      kind: 'hotel', query: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25',
      adults: 2, currency: 'EUR',
    })
    // The item HAS one, so this is a real omission and not an empty field.
    expect(item!.bookingUrl).toContain('https://example.invalid/')
    expect(Object.keys(itemForModel(item!))).not.toContain('bookingUrl')
    expect(JSON.stringify(itemForModel(item!))).not.toContain('example.invalid')
  })
  it('sends the exact minor units beside the formatted price', async () => {
    const [item] = await mockSuppliers().flight.search({
      kind: 'flight', from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: null,
      flexDays: 0, adults: 2, children: 1, infants: 0, cabinClass: 'Economy',
      currency: 'EUR', maxStops: null, allowSelfTransfer: false,
    })
    const wire = itemForModel(item!) as { price: { minor: string; currency: string; formatted: string } }
    expect(wire.price.minor).toBe(item!.price.minor.toString())
    expect(wire.price.currency).toBe('EUR')
    expect(wire.price.formatted).toContain('€')
  })
})
