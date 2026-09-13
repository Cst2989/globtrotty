import { randomUUID } from 'node:crypto'
import { liveClient } from '../src/client.js'
import { loadGoldenCases } from '../src/evals/cases.js'
import { makeLiveSimulatedUser } from '../src/evals/sim-user.js'
import { SEATS } from '../src/seats.js'
import { withTestDb } from './helpers/db.js'
import { describeLiveModel, requireModelKey } from './helpers/live.js'

const persona = loadGoldenCases()[0]!.persona

describeLiveModel('the traveller on a real model', () => {
  it('answers from her facts and writes a priced row on her own seat', async () => {
    // Called INSIDE the `it` and never in the describe callback, because vitest
    // runs a suite's factory during collection even when the suite is
    // `describe.skip`, so a throw in a describe body fires on every machine.
    // Without LIVE_MODEL=1 and a key this file reports SKIPPED rather than
    // passed, which is what keeps a run with no credentials from reading like a
    // run that verified the live path.
    requireModelKey()
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
      const her = makeLiveSimulatedUser(persona, {
        sql, client: liveClient(),
        ctx: { userId, conversationId: c!.id as string, turnId: null },
        now: Date.now,
      })
      const said = await her.reply('How many nights are you staying, and where are you flying from?')
      // A property, never the wording: the model is free to phrase it, and a
      // fixture-style comparison here would go red on a good answer.
      expect(said.toLowerCase()).toContain('berlin')
      const rows = await sql<{ seat: string; model_config_id: string; cost_micros: string }[]>`
        select seat, model_config_id, cost_micros from course.model_calls
         where user_id = ${userId} order by seq`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.seat).toBe('sim_user')
      expect(rows[0]!.model_config_id).toBe(SEATS.sim_user.modelConfigId)
      expect(BigInt(rows[0]!.cost_micros)).toBeGreaterThan(0n)
    })
  }, 120_000)
})
