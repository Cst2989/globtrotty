import { mockSuppliers } from '../src/supplier/mock.js'
import type { Supplier } from '../src/supplier/types.js'
import { itemForModel, mockRunner, TOOLS } from '../src/tools.js'

describe('tools', () => {
  const run = mockRunner()
  it('describes both searches with a JSON schema the API accepts', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['search_flights', 'search_hotels'])
    expect(TOOLS[0]?.input_schema.type).toBe('object')
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
