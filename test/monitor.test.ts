import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { runMonitor, shapeOfTurn } from '../src/monitor.js'
import { fakeClient } from './model/fake.js'

const USER = randomUUID()

/**
 * A `postgres.Sql` whose every query rejects. The monitor's rule is that nothing
 * it does can fail a turn, and a database that is down is the case that would
 * break the rule: `readFeed` and `turnSpendMicros` both run before the model
 * call, so a monitor that let a read propagate would take the turn with it.
 */
function throwingSql(): postgres.Sql {
  const sql = (async () => { throw new Error('database is down') }) as unknown as postgres.Sql
  return sql
}

describe('what the monitor can see', () => {
  const started = (name: string) => ({ kind: 'tool_start' as const, detail: name })

  it('counts six searches and no proposal, which is the shape nothing else names', () => {
    // Every gate passed, every ceiling held, and the turn did nothing for her.
    // No deterministic check in this system has a name for that, which is the
    // whole argument for a monitor that alarms.
    const shape = shapeOfTurn([
      ...Array.from({ length: 6 }, () => started('search_hotels')),
      ...Array.from({ length: 6 }, () => ({ kind: 'tool_done' as const, detail: 'search_hotels' })),
    ], 400_000n)
    expect(shape.searches).toBe(6)
    expect(shape.proposals).toBe(0)
    expect(shape.toolsStarted).toBe(shape.toolsFinished)
  })

  it('notices a tool that started and never finished', () => {
    // A `tool_start` with no `tool_done` is the process that died mid call, and
    // it is the same fact `countSupplierCalls` reads off a stuck `pending` row
    // (lesson 5.2). Two views of one failure, and neither is an error.
    const shape = shapeOfTurn([started('search_flights')], 0n)
    expect(shape.toolsStarted).toBe(1)
    expect(shape.toolsFinished).toBe(0)
  })

  it('reports an escalation without reading a fail reason', () => {
    const shape = shapeOfTurn([{ kind: 'escalated', detail: 'outside_scope' }], 0n)
    expect(shape.escalated).toBe(true)
  })

  it('counts a proposal apart from a search, off the same rows', () => {
    // `searches` is every `search_` tool and `proposals` is the one name, so a
    // turn that searched twice and proposed once reads as what it was.
    const shape = shapeOfTurn([
      started('search_flights'), started('search_hotels'), started('propose_itinerary'),
    ], 1_000n)
    expect(shape.searches).toBe(2)
    expect(shape.proposals).toBe(1)
    expect(shape.toolsStarted).toBe(3)
  })

  it('cannot fail a turn, whatever the model says', async () => {
    // The rule, asserted. A client that throws, a database that throws, a reply
    // that is a refusal: none of them may propagate. A monitor with a veto is a
    // second decision point on the money path running on a cheap seat.
    const deps = { sql: throwingSql(), client: fakeClient([]), now: Date.now }
    await expect(runMonitor(deps, { userId: USER, conversationId: 'c1', turnId: 't1' }))
      .resolves.toBeUndefined()
  })
})
