import { checkBudget, checkDates, checkSlots, checkTotals } from '../src/gates/checks.js'
import { SLOT_KINDS } from '../src/gates/types.js'
import { money } from '../src/money.js'
import type { RehydratedItem } from '../src/gates/types.js'
import type { PriceBasis, SupplierItem } from '../src/supplier/types.js'

function hotel(id: string, minor: bigint, quantity = 1, basis: PriceBasis = 'total'): RehydratedItem {
  const item: SupplierItem = {
    sourceId: id, supplier: 'mock', kind: 'hotel', name: id,
    price: money(minor, 'EUR'), priceBasis: basis,
    fetchedAt: new Date('2026-08-16T12:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: { kind: 'hotel', checkIn: '2026-09-12', checkOut: '2026-09-19',
              nights: 7, rating: null, coordinates: null, offerSource: null },
  }
  return { ref: { sourceId: id, quantity, slot: 'stay' }, item,
           lineTotal: money(minor * BigInt(quantity), 'EUR') }
}

function flight(id: string, dep: string, ret: string): RehydratedItem {
  const item: SupplierItem = {
    sourceId: id, supplier: 'kiwi', kind: 'flight', name: id,
    price: money(10_000n, 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-08-16T12:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'flight',
      outbound: { from: 'BER', to: 'FAO', departureLocal: dep, arrivalLocal: dep,
                  stops: 0, route: [], cabinClass: 'Economy', carriers: [], flightNumbers: [] },
      inbound: { from: 'FAO', to: 'BER', departureLocal: ret, arrivalLocal: ret,
                 stops: 0, route: [], cabinClass: 'Economy', carriers: [], flightNumbers: [] },
      baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
      totalDurationSeconds: 1, selfTransfer: false,
    },
  }
  return { ref: { sourceId: id, quantity: 1, slot: 'flight' }, item, lineTotal: item.price }
}

/** Re-slot an item without touching anything else. */
function inSlot(r: RehydratedItem, slot: string): RehydratedItem {
  return { ...r, ref: { ...r.ref, slot } }
}

/** Re-price an item without touching anything else, currency included. */
function inCurrency(r: RehydratedItem, minor: bigint, currency: string): RehydratedItem {
  return { ...r, item: { ...r.item, price: money(minor, currency) }, lineTotal: money(minor, currency) }
}

describe('checkTotals', () => {
  it('sums line totals server side', () => {
    const r = checkTotals([hotel('A', 10_000n), hotel('B', 5_000n)], 'EUR')
    expect(r.violations).toEqual([])
    // Pinned exactly. An implementation that dropped an item, or summed only
    // the first, produces a different number here.
    expect(r.total!.minor).toBe(15_000n)
    expect(r.total!.currency).toBe('EUR')
  })

  it('refuses to sum mixed price bases', () => {
    const r = checkTotals([hotel('A', 10_000n, 1, 'total'), hotel('B', 5_000n, 1, 'pre_tax')], 'EUR')
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]!.gate).toBe('totals')
    expect(r.total).toBeNull()
    expect(r.violations[0]!.detail).toMatch(/tax/i)
    // Every item is named, not a subset: with two bases present there is no
    // single odd one out, and picking the minority tells the model to
    // re-search the wrong half.
    expect([...r.violations[0]!.sourceIds].sort()).toEqual(['A', 'B'])
  })

  it('refuses to sum mixed currencies rather than throwing', () => {
    const r = checkTotals([hotel('A', 10_000n), inCurrency(hotel('G', 1_000n), 1_000n, 'GBP')], null)
    expect(r.violations).toHaveLength(1)
    expect(r.total).toBeNull()
  })

  it('delegates mixed-currency detection to checkCurrency instead of re-detecting it', () => {
    const r = checkTotals([hotel('A', 10_000n), inCurrency(hotel('G', 1_000n), 1_000n, 'GBP')], null)
    // The gate that owns currency reports it. `totals` must not file a second
    // description of the same fault.
    expect(r.violations.map((v) => v.gate)).toEqual(['currency'])
  })

  it('fails an item whose currency is not the trip currency, even when the set agrees with itself', () => {
    const r = checkTotals([hotel('A', 10_000n), hotel('B', 5_000n)], 'GBP')
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]!.gate).toBe('currency')
    expect(r.total).toBeNull()
  })

  it('returns a null total and no violation for an empty set', () => {
    expect(checkTotals([], 'EUR')).toEqual({ violations: [], total: null })
    expect(checkTotals([], null)).toEqual({ violations: [], total: null })
  })

  it('recomputes rather than trusting a tampered lineTotal', () => {
    // The handed-in lineTotal is a lie by four orders of magnitude. A summer
    // that trusted it returns 1n; recomputing from the corpus price returns
    // 10_000n.
    const lying = { ...hotel('L', 10_000n), lineTotal: money(1n, 'EUR') }
    expect(checkTotals([lying], 'EUR').total!.minor).toBe(10_000n)
  })

  it('reports both faults when a set mixes bases AND currencies', () => {
    const mixed = inCurrency(hotel('G', 1_000n, 1, 'pre_tax'), 1_000n, 'GBP')
    const r = checkTotals([hotel('A', 10_000n, 1, 'total'), mixed], null)
    expect(r.violations.map((v) => v.gate).sort()).toEqual(['currency', 'totals'])
    expect(r.total).toBeNull()
  })

  it('returns a violation rather than throwing on a non-integer quantity', () => {
    // itemTotal throws on this, and a gate that throws is a gate that takes the
    // whole turn down.
    const bad = { ...hotel('Q', 10_000n), ref: { sourceId: 'Q', quantity: 1.5, slot: 'stay' } }
    const r = checkTotals([bad], 'EUR')
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]!.gate).toBe('totals')
    expect(r.violations[0]!.sourceIds).toEqual(['Q'])
    expect(r.violations[0]!.detail).toMatch(/quantit/i)
    expect(r.total).toBeNull()
  })

  it('returns a violation rather than throwing on a zero quantity', () => {
    const bad = { ...hotel('Z', 10_000n), ref: { sourceId: 'Z', quantity: 0, slot: 'stay' } }
    const r = checkTotals([bad], 'EUR')
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]!.sourceIds).toEqual(['Z'])
    expect(r.total).toBeNull()
  })

  /**
   * The quantity hole. It is the one number in a proposal the model still
   * controls and it multiplies straight into the trip total, and every supplier
   * this branch ships prices the WHOLE booking, so 1 is the only correct
   * multiplier. These assert the VIOLATION and deliberately not an inflated
   * total: a test that checked `total === 20_000n` would pass against the bug.
   */
  it('refuses a quantity of 2 rather than doubling a price that already covers the booking', () => {
    const two = { ...hotel('Q2', 10_000n), ref: { sourceId: 'Q2', quantity: 2, slot: 'stay' } }
    const r = checkTotals([two], 'EUR')
    expect(r.total).toBeNull()                       // NOT money(20_000n, 'EUR')
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]!.gate).toBe('totals')
    expect(r.violations[0]!.sourceIds).toEqual(['Q2'])
    expect(r.violations[0]!.detail).toContain('quantity above 1')
    expect(r.violations[0]!.detail).toContain('Q2 (2)')
  })

  it('refuses the schema\'s maximum quantity too, and names every offender', () => {
    const a = { ...hotel('A', 10_000n), ref: { sourceId: 'A', quantity: 16, slot: 'stay' } }
    const b = { ...hotel('B', 5_000n), ref: { sourceId: 'B', quantity: 3, slot: 'stay' } }
    const r = checkTotals([a, b, hotel('C', 1_000n)], 'EUR')
    expect(r.total).toBeNull()
    const totals = r.violations.filter((v) => v.gate === 'totals')
    expect(totals).toHaveLength(1)
    // C is quantity 1 and is NOT an offender: the message must not tell the
    // model to change a line that is already correct.
    expect(totals[0]!.sourceIds).toEqual(['A', 'B'])
  })

  // The other side of the boundary. 1 is not merely "not rejected": it is the
  // value that still produces a real total, so this pins that the check did not
  // simply refuse everything.
  it('accepts a quantity of exactly 1 and still totals it', () => {
    const r = checkTotals([hotel('A', 10_000n), hotel('B', 5_000n)], 'EUR')
    expect(r.violations).toEqual([])
    expect(r.total!.minor).toBe(15_000n)
  })

  // A fractional quantity is both "not a whole number" and "above 1".
  // Describing it twice hands the model two sentences about one line and makes
  // it guess whether it has two problems.
  it('reports a fractional quantity once, not once per quantity rule', () => {
    const bad = { ...hotel('F', 10_000n), ref: { sourceId: 'F', quantity: 1.5, slot: 'stay' } }
    const r = checkTotals([bad], 'EUR')
    expect(r.violations.filter((v) => v.gate === 'totals')).toHaveLength(1)
    expect(r.violations[0]!.detail).toMatch(/quantit/i)
    expect(r.violations[0]!.detail).not.toContain('quantity above 1')
  })
})

describe('checkBudget', () => {
  it('passes a total at exactly the budget', () => {
    const items = [hotel('A', 10_000n)]
    expect(checkBudget(items, checkTotals(items, 'EUR'), money(10_000n, 'EUR'))).toEqual([])
  })

  it('fails a total one minor unit over', () => {
    const items = [hotel('A', 10_001n)]
    const v = checkBudget(items, checkTotals(items, 'EUR'), money(10_000n, 'EUR'))
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('budget')
    expect(v[0]!.sourceIds).toEqual(['A'])
    // Pin both figures AND their roles. Two bare toContain calls also pass
    // against "totals €100.00, over the €100.01 budget", which names the right
    // two numbers and swaps them.
    expect(v[0]!.detail).toContain('totals €100.01')
    expect(v[0]!.detail).toContain('over the €100.00 budget')
  })

  it('passes a total one minor unit under', () => {
    const items = [hotel('A', 9_999n)]
    expect(checkBudget(items, checkTotals(items, 'EUR'), money(10_000n, 'EUR'))).toEqual([])
  })

  it('passes when no budget is set', () => {
    const items = [hotel('A', 999_999n)]
    expect(checkBudget(items, checkTotals(items, null), null)).toEqual([])
  })

  it('fails closed when the budget currency differs from the items', () => {
    const items = [hotel('A', 100n)]
    // The items agree with each other, so checkTotals produces a total; the
    // mismatch is between that total and the budget, and comparing them would
    // throw CurrencyMismatchError. It has to be a violation instead.
    const totals = checkTotals(items, null)
    expect(totals.total!.currency).toBe('EUR')
    const v = checkBudget(items, totals, money(999_999n, 'GBP'))
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('budget')
    expect(v[0]!.detail).toContain('GBP')
    expect(v[0]!.detail).toContain('EUR')
  })

  it('does not run its own sum when totals already failed', () => {
    const items = [hotel('A', 10n, 1, 'total'), hotel('B', 10n, 1, 'pre_tax')]
    const totals = checkTotals(items, 'EUR')
    expect(totals.total).toBeNull()
    expect(totals.violations).toHaveLength(1)
    // Mixed bases mean there is no trustworthy total. Budget must not invent
    // one and must not file a second description of a fault totals reported.
    expect(checkBudget(items, totals, money(1n, 'EUR'))).toEqual([])
  })

  it('passes an empty set rather than throwing on an empty sum', () => {
    expect(checkBudget([], checkTotals([], 'EUR'), money(1n, 'EUR'))).toEqual([])
  })

  it('produces exactly ONE violation for one mixed-currency proposal', () => {
    const items = [hotel('A', 10_000n), inCurrency(hotel('G', 1_000n), 1_000n, 'GBP')]
    const totals = checkTotals(items, null)
    const all = [...totals.violations, ...checkBudget(items, totals, money(50_000n, 'EUR'))]
    // One fault, one violation. The shape this replaces produced three:
    // `currency` from checkCurrency, `totals` re-detecting it, and `budget`
    // re-detecting it a third time through its own internal checkTotals call.
    expect(all).toHaveLength(1)
    expect(all[0]!.gate).toBe('currency')
  })
})

describe('checkDates', () => {
  const win = { earliest: '2026-09-10', latest: '2026-09-20' }

  it('passes flights inside the window', () => {
    expect(checkDates([flight('F', '2026-09-12T16:40:00', '2026-09-19T08:00:00')], win)).toEqual([])
  })

  it('fails a departure before the window', () => {
    const v = checkDates([flight('EARLY', '2026-09-09T23:59:00', '2026-09-19T08:00:00')], win)
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('dates')
    expect(v[0]!.sourceIds).toEqual(['EARLY'])
  })

  it('fails a return after the window', () => {
    expect(checkDates([flight('LATE', '2026-09-12T10:00:00', '2026-09-21T00:01:00')], win)).toHaveLength(1)
  })

  /**
   * The trap this whole gate is built around. 23:59 on the final day is inside
   * a window expressed in whole local days, and the timestamp carries no
   * offset. `new Date()` on a zoneless string applies the SERVER's zone, and in
   * a negative-offset zone, which this suite pins deliberately
   * (America/Los_Angeles, vitest.config.ts), the resulting instant is
   * 2026-09-21T06:59Z: a day later than the traveller's own calendar says.
   *
   * The 00:00 lower bound is the mirror of the same trap and rolls backwards
   * only under a positive offset, which this suite does not pin, so it is inert
   * here. It stays in the fixture to keep the case honest, not because it
   * discriminates.
   */
  it('compares date prefixes, so a late local time on the last day still passes', () => {
    expect(checkDates([flight('EDGE', '2026-09-10T00:00:00', '2026-09-20T23:59:00')], win)).toEqual([])
  })

  it('is exact at both boundaries', () => {
    expect(checkDates([flight('IN', '2026-09-10T12:00:00', '2026-09-20T12:00:00')], win)).toEqual([])
    expect(checkDates([flight('OUT_LO', '2026-09-09T12:00:00', '2026-09-20T12:00:00')], win)).toHaveLength(1)
    expect(checkDates([flight('OUT_HI', '2026-09-10T12:00:00', '2026-09-21T12:00:00')], win)).toHaveLength(1)
  })

  it('checks hotel check-in and check-out too', () => {
    const late = hotel('H', 1n)
    const shifted = { ...late, item: { ...late.item, detail: {
      kind: 'hotel' as const, checkIn: '2026-09-12', checkOut: '2026-09-30',
      nights: 18, rating: null, coordinates: null, offerSource: null } } }
    const v = checkDates([shifted], win)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['H'])
  })

  it('groups every out-of-window item into one violation', () => {
    const v = checkDates([
      flight('E1', '2026-09-01T10:00:00', '2026-09-12T10:00:00'),
      flight('OK', '2026-09-12T10:00:00', '2026-09-13T10:00:00'),
      flight('E2', '2026-09-12T10:00:00', '2026-09-30T10:00:00'),
    ], win)
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['E1', 'E2'])
  })

  it('passes when no window is set', () => {
    // Which is every proposal on this branch today: the course notebook holds a
    // month, not two dates, so constraintsFromNotebook yields no window and the
    // pipeline records `dates` as not evaluated rather than as a pass. This
    // gate ships fully tested against a window a caller supplies, and lesson
    // 5.3 is where the notebook grows one.
    expect(checkDates([flight('F', '2020-01-01T00:00:00', '2030-01-01T00:00:00')], null)).toEqual([])
  })
})

describe('checkSlots', () => {
  it('accepts a flight in a flight slot and a hotel in the stay slot', () => {
    expect(checkSlots([
      inSlot(flight('F', '2026-09-12T10:00:00', '2026-09-19T10:00:00'), 'outbound'),
      inSlot(flight('G', '2026-09-12T10:00:00', '2026-09-19T10:00:00'), 'inbound'),
      inSlot(flight('H', '2026-09-12T10:00:00', '2026-09-19T10:00:00'), 'flight'),
      inSlot(hotel('S', 100n), 'stay'),
    ])).toEqual([])
  })

  it('rejects a hotel proposed for a flight slot', () => {
    const v = checkSlots([inSlot(hotel('S', 100n), 'outbound')])
    expect(v).toHaveLength(1)
    expect(v[0]!.gate).toBe('slots')
    expect(v[0]!.sourceIds).toEqual(['S'])
    expect(v[0]!.detail).toContain('outbound')
    expect(v[0]!.detail).toContain('hotel')
  })

  it('rejects a flight proposed for the stay slot', () => {
    const v = checkSlots([inSlot(flight('F', '2026-09-12T10:00:00', '2026-09-19T10:00:00'), 'stay')])
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['F'])
  })

  it('rejects an unknown slot name and lists the vocabulary', () => {
    const v = checkSlots([inSlot(hotel('S', 100n), 'penthouse')])
    expect(v).toHaveLength(1)
    expect(v[0]!.detail).toContain('penthouse')
    for (const name of Object.keys(SLOT_KINDS)) expect(v[0]!.detail).toContain(name)
  })

  /**
   * `slot` is model-controlled and this function is exported and reachable
   * without the schema's enum, so a bare `SLOT_KINDS[slot]` returns a function
   * for 'toString' and an object for '__proto__'. Both are truthy, so they skip
   * the unknown-name branch and get misreported as a wrong-KIND fault with a
   * message nobody can act on ('slot "toString" takes a function toString() {
   * [native code] }'). `Object.hasOwn` is the fix.
   */
  it('rejects Object.prototype keys as slot names rather than resolving them', () => {
    for (const key of ['__proto__', 'toString', 'constructor', 'valueOf']) {
      const v = checkSlots([inSlot(hotel('P', 100n), key)])
      expect(v).toHaveLength(1)
      expect(v[0]!.gate).toBe('slots')
      expect(v[0]!.sourceIds).toEqual(['P'])
      // Classified as an unknown NAME, not a kind mismatch: the unknown-name
      // message is the one that lists the vocabulary.
      expect(v[0]!.detail).toContain('does not exist')
      expect(v[0]!.detail).toContain('outbound, inbound, flight, stay')
      expect(v[0]!.detail).not.toContain('native code')
    }
  })

  it('keys off detail.kind, not the sibling item.kind field', () => {
    // SupplierItem does not couple the two, and the corpus round trip reads
    // `detail` back as unvalidated jsonb, so a row where they disagree is
    // possible. checkDates trusts detail.kind; this gate must agree, or one
    // inconsistent row is slot-checked as a flight and date-checked as a hotel.
    const h = inSlot(hotel('SPOOF', 100n), 'stay')
    expect(checkSlots([{ ...h, item: { ...h.item, kind: 'flight' as const } }])).toEqual([])

    const f = inSlot(flight('SPOOF2', '2026-09-12T10:00:00', '2026-09-19T10:00:00'), 'stay')
    const v = checkSlots([{ ...f, item: { ...f.item, kind: 'hotel' as const } }])
    expect(v).toHaveLength(1)
    expect(v[0]!.detail).toContain('SPOOF2 is a flight')
  })

  it('is case-sensitive: the vocabulary is exactly the documented names', () => {
    // The set is closed and the tool description publishes it. Quietly
    // accepting 'Stay' would make the published set a lie.
    expect(checkSlots([inSlot(hotel('S', 100n), 'Stay')])).toHaveLength(1)
  })

  it('reports unknown names and kind mismatches as separate violations', () => {
    const v = checkSlots([
      inSlot(hotel('BADNAME', 100n), 'nowhere'),
      inSlot(hotel('BADKIND', 100n), 'inbound'),
      inSlot(hotel('FINE', 100n), 'stay'),
    ])
    expect(v).toHaveLength(2)
    expect([...v.map((x) => x.sourceIds.join(','))].sort()).toEqual(['BADKIND', 'BADNAME'])
  })

  it('groups every offender of the same kind into one violation', () => {
    const v = checkSlots([inSlot(hotel('A', 100n), 'outbound'), inSlot(hotel('B', 100n), 'inbound')])
    expect(v).toHaveLength(1)
    expect(v[0]!.sourceIds).toEqual(['A', 'B'])
  })

  it('passes an empty set', () => {
    expect(checkSlots([])).toEqual([])
  })

  it('exposes the slot vocabulary as one constant, not scattered literals', () => {
    expect(SLOT_KINDS).toEqual({ outbound: 'flight', inbound: 'flight', flight: 'flight', stay: 'hotel' })
  })
})
