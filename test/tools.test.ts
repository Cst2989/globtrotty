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
    // 's0-b0' is a call id: mockRunner ignores it, but calling a value typed
    // as ToolRunner needs all three arguments regardless (src/tools.ts).
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
