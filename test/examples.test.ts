import { similarity, type BookedSet } from '../src/loop/similarity.js'
import { REFS_SCHEMA_VERSION } from '../src/repo/proposals.js'
import { valueOr } from '../src/loop/derive.js'

const ref = (slot: string, sourceId: string) => ({ sourceId, quantity: 1, slot })
const booked = (proposalId: string, ids: string[]): BookedSet =>
  ({ proposalId, itemIds: new Set(ids) })

describe('an unsegmented survival ranking', () => {
  it('puts the one-component trips above the trip that was actually hard', () => {
    // Her hotel-only request: one component, booked exactly as proposed.
    const easy = similarity(
      { id: 'hotel-only', refs: [ref('stay', 'mock-hotel-1')], refsSchemaVersion: REFS_SCHEMA_VERSION },
      booked('hotel-only', ['mock-hotel-1']))
    const alsoEasy = similarity(
      { id: 'flight-only', refs: [ref('flight', 'mock-flight-1')], refsSchemaVersion: REFS_SCHEMA_VERSION },
      booked('flight-only', ['mock-flight-1']))
    // Her Portugal trip with the toddler: three components, and she swapped the
    // transfer for one we would never have found, which is the trip a person
    // calls an agency for.
    const hard = similarity(
      {
        id: 'portugal-toddler',
        refs: [ref('flight', 'mock-flight-1'), ref('stay', 'mock-hotel-1'), ref('transfer', 'mock-transfer-1')],
        refsSchemaVersion: REFS_SCHEMA_VERSION,
      },
      booked('portugal-toddler', ['mock-flight-1', 'mock-hotel-1', 'mock-transfer-7']))
    const ranked = [easy, alsoEasy, hard]
      .map((s, i) => ({ value: valueOr(s, 0), id: ['hotel-only', 'flight-only', 'portugal-toddler'][i]! }))
      .sort((a, b) => b.value - a.value)
    // Both easy trips outrank the hard one, and with two examples in the prompt
    // the hard one is never shown to the desk. Run monthly, the desk's examples
    // become a gallery of one-component bookings, and the agency gets worse at
    // exactly the requests it exists for.
    expect(ranked.map((r) => r.id)).toEqual(['hotel-only', 'flight-only', 'portugal-toddler'])
    expect(ranked[2]!.value).toBeLessThan(ranked[0]!.value)
  })

  it('cannot tell a bad proposal from a hard trip, because both look like a heavy edit', () => {
    const badProposal = similarity(
      { id: 'bad', refs: [ref('stay', 'mock-hotel-1')], refsSchemaVersion: REFS_SCHEMA_VERSION },
      booked('bad', ['mock-hotel-9']))
    const hardTrip = similarity(
      {
        id: 'hard',
        refs: [ref('flight', 'mock-flight-1'), ref('stay', 'mock-hotel-1')],
        refsSchemaVersion: REFS_SCHEMA_VERSION,
      },
      booked('hard', ['mock-flight-1', 'mock-hotel-9', 'mock-transfer-7']))
    // Neither number knows which it is looking at, and the ranking treats them
    // as the same evidence. The fix is not a better number, it is a smaller
    // question: compare within difficulty and never across it.
    expect(valueOr(badProposal, 1)).toBeLessThan(0.5)
    expect(valueOr(hardTrip, 1)).toBeLessThan(0.5)
  })
})
