import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner, TOOLS } from '../src/tools.js'

describe('tools', () => {
  const run = mockRunner(new MockSupplier())
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
})
