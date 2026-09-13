import { gradeOutput } from '../src/evals/grade.js'
import { money } from '../src/money.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch, SupplierItem } from '../src/supplier/types.js'

const SEARCH: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO',
  departureDate: '2026-09-19', returnDate: '2026-09-26', flexDays: 0,
  adults: 2, children: 1, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

const EXPECTED = {
  budget: money(150_000n, 'EUR'),
  currency: 'EUR',
  mustInclude: ['crib'],
  window: { earliest: '2026-09-15', latest: '2026-09-30' },
}

/** What the offers look like to a snapshot: the fields a reviewer would eyeball. */
const shapeOf = (items: SupplierItem[]) =>
  items.map((i) => ({ sourceId: i.sourceId, name: i.name, minor: i.price.minor.toString() }))

describe('the snapshot test module 5 would have written', () => {
  it('passes, until somebody reseeds the world for an unrelated reason', async () => {
    const world = await mockSuppliers().flight.search(SEARCH)
    const snapshot = shapeOf(world)
    // It passes against itself, every time, because the mock is deterministic.
    expect(shapeOf(await mockSuppliers().flight.search(SEARCH))).toEqual(snapshot)

    // A second world, every fare in it as defensible as the first. Nothing about
    // the agency changed: `seed` is a MockConfig field that exists so one test
    // can hold two worlds (src/supplier/mock.ts), and this is the variation a
    // real supplier produces every hour of every day.
    const other = await mockSuppliers({ flight: { seed: 2 } }).flight.search(SEARCH)
    expect(shapeOf(other)).not.toEqual(snapshot)
    // Red, over a difference nobody cares about. Asserted rather than described,
    // because a lesson that says a test would fail and does not show it failing
    // is a lesson the reader has to take on trust.
    expect(() => expect(shapeOf(other)).toEqual(snapshot)).toThrow()
  })

  it('is replaced by a grader that can tell the two worlds apart', async () => {
    const items = await mockSuppliers({ hotel: { seed: 77 } }).hotel.search(STAY)
    const rehydrated = items.map((item) => ({
      ref: { sourceId: item.sourceId, quantity: 1, slot: 'stay' }, item, lineTotal: item.price,
    }))
    // The loosened snapshot passed this world. The grader files the currency and
    // the crib as verdicts, and files the budget as unreached with the lesson
    // that reaches it, which is a different sentence from "fine".
    //
    // The reply omits the word rather than denying it: `mustInclude` is a
    // substring test, so "no crib mentioned" would satisfy the check it is
    // written to fail.
    const grade = gradeOutput('A stay in Faro, and nothing about what she asked for twice.',
      rehydrated, EXPECTED)
    expect(grade.checks.find((c) => c.name === 'must_include')!.passed).toBe(false)
    expect(grade.checks.find((c) => c.name === 'within_budget')!.passed).toBeNull()
  })
})
