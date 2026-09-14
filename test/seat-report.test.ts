import { randomUUID } from 'node:crypto'
import { fineTuneCorpus, FINE_TUNE_MINIMUM, renderSeatReport, seatReport, usd } from '../src/loop/seats.js'
import { describeDb, withRealDb } from './helpers/db.js'

describe('usd', () => {
  it('renders zero as four zero places', () => {
    expect(usd(0n)).toBe('$0.0000')
  })

  it('does not round a sub-cent Haiku call to nothing', () => {
    // $0.0042, real Haiku money that two decimal places would print as $0.00.
    expect(usd(4_200n)).toBe('$0.0042')
  })

  it('renders a whole dollar with no remainder', () => {
    expect(usd(1_000_000n)).toBe('$1.0000')
  })

  it('keeps a value a float would lose precision on', () => {
    // 2^53 + 1: the first integer a double cannot represent exactly, so this
    // assertion only holds if usd() never routes the amount through Number.
    expect(Number.isSafeInteger(9_007_199_254_740_993)).toBe(false)
    expect(usd(9_007_199_254_740_993n)).toBe('$9007199254.7409')
  })

  it('renders a negative amount with the sign in front of the dollar', () => {
    expect(usd(-500_000n)).toBe('-$0.5000')
  })
})

describe('renderSeatReport', () => {
  it('prints $0.0000 per turn for a seat with zero turns, rather than dividing by zero', () => {
    const out = renderSeatReport(
      [{ seat: 'monitor', calls: 3, turns: 0, conversations: 0, costMicros: 900n }],
      [],
    )
    expect(out).toContain('$0.0000 per turn')
  })

  it('prints a gate row for every gate it is given, beside the seats', () => {
    const out = renderSeatReport(
      [{ seat: 'driver', calls: 1, turns: 1, conversations: 1, costMicros: 1_000_000n }],
      [{ name: 'gate:budget', tally: { passed: 2, failed: 1, notEvaluated: 0 } }],
    )
    expect(out).toContain('gate:budget  2 passed, 1 failed, 0 not evaluated')
  })

  it('sums the seats into a total line', () => {
    const out = renderSeatReport(
      [
        { seat: 'driver', calls: 1, turns: 1, conversations: 1, costMicros: 700_000n },
        { seat: 'cheap', calls: 1, turns: 1, conversations: 1, costMicros: 300_000n },
      ],
      [],
    )
    expect(out).toContain('$1.0000')
  })
})

describeDb('seatReport', () => {
  it('groups by seat, orders the cheaper one second, sums the total, and counts a '
    + 'null-turn call in calls and not in turns', async () => {
    await withRealDb(async (sql, userId) => {
      const [conversation] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const [turn] = await sql<{ id: string }[]>`
        insert into course.turns (conversation_id, user_id, idempotency_key)
        values (${conversation!.id}, ${userId}, ${randomUUID()}) returning id`
      const call = (seat: string, costMicros: bigint, turnId: string | null,
        conversationId: string | null) => sql`
        insert into course.model_calls
          (conversation_id, user_id, turn_id, seat, prompt_version,
           model_requested, model_returned, cost_micros)
        values (${conversationId}, ${userId}, ${turnId}, ${seat}, 'v1',
                'claude-opus-5', 'claude-opus-5', ${costMicros.toString()})`
      // Two driver calls in the same turn: 1,000,000 micros, one turn.
      await call('driver', 500_000n, turn!.id, conversation!.id)
      await call('driver', 500_000n, turn!.id, conversation!.id)
      // One cheap call inside the turn, and one made before a turn existed:
      // both are calls, only the first is a turn.
      await call('cheap', 100_000n, turn!.id, conversation!.id)
      await call('cheap', 1n, null, null)

      const rows = await seatReport(sql, { userId })
      expect(rows.map((r) => r.seat)).toEqual(['driver', 'cheap'])

      const driver = rows.find((r) => r.seat === 'driver')!
      expect(driver.calls).toBe(2)
      expect(driver.turns).toBe(1)
      expect(driver.conversations).toBe(1)
      expect(driver.costMicros).toBe(1_000_000n)

      const cheap = rows.find((r) => r.seat === 'cheap')!
      expect(cheap.calls).toBe(2)
      expect(cheap.turns).toBe(1)
      expect(cheap.costMicros).toBe(100_001n)

      const total = rows.reduce((sum, r) => sum + r.costMicros, 0n)
      expect(total).toBe(1_100_001n)
    })
  })
})

describeDb('fineTuneCorpus', () => {
  it('reads the real count on a branch with a handful of conversations, and reports not enough', async () => {
    await withRealDb(async (sql, userId) => {
      for (let i = 0; i < 3; i += 1) {
        const [conversation] = await sql<{ id: string }[]>`
          insert into course.conversations (user_id) values (${userId}) returning id`
        await sql`
          insert into course.messages (conversation_id, user_id, role, content)
          values (${conversation!.id}, ${userId}, 'user', 'take me somewhere warm')`
      }
      const corpus = await fineTuneCorpus(sql, { userId })
      expect(corpus.labelled).toBe(3)
      expect(corpus.corrected).toBe(0)
      expect(corpus.minimum).toBe(FINE_TUNE_MINIMUM)
      expect(corpus.enough).toBe(false)
    })
  })
})
