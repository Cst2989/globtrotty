import { randomUUID } from 'node:crypto'
import { submitMessage } from '../src/handler.js'
import { readTurnLabels, recordTurnLabels } from '../src/repo/turnLabels.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()

describeDb('the counters that outlive the window', () => {
  it('writes one row per turn and refuses a second for the same turn', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'A week in Faro.', idempotencyKey: randomUUID(),
      })
      const counters = {
        toolCalls: 3, questionsAsked: 1, searchesBeforeFirstQuestion: 0,
        pricesQuoted: 2, unbackedPrices: 1,
      }
      const args = {
        turnId: submitted.turnId!, conversationId: submitted.conversationId, userId: USER, counters,
      }
      await recordTurnLabels(sql, args)
      // Inside `sql.begin`, which `withTestDb` shims onto a savepoint: a
      // constraint violation aborts the transaction it happens in, so a refusal
      // asserted directly on the outer one would take the read below down with
      // it. test/schema-corpus.test.ts asserts every one of its constraints
      // this way for the same reason.
      await expect(sql.begin(() => recordTurnLabels(sql, args)))
        .rejects.toThrow(/turn_labels_pkey/)
      expect(await readTurnLabels(sql, { conversationId: submitted.conversationId, userId: USER }))
        .toEqual([{ turnId: submitted.turnId!, ...counters }])
    })
  })

  it('refuses more unbacked prices than prices', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'Faro.', idempotencyKey: randomUUID(),
      })
      await expect(sql.begin(() => recordTurnLabels(sql, {
        turnId: submitted.turnId!, conversationId: submitted.conversationId, userId: USER,
        counters: {
          toolCalls: 1, questionsAsked: 0, searchesBeforeFirstQuestion: 0,
          pricesQuoted: 1, unbackedPrices: 2,
        },
      }))).rejects.toThrow(/turn_labels_unbacked_within_quoted/)
    })
  })

  it('leaves a turn with no row distinguishable from a turn with zeroes', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'Faro.', idempotencyKey: randomUUID(),
      })
      // No write. The read returns nothing, which is not the same answer as a
      // row of zeroes, and the difference is what makes the rate's denominator
      // real rather than a number that improves when a write fails.
      expect(await readTurnLabels(sql, { conversationId: submitted.conversationId, userId: USER }))
        .toEqual([])
    })
  })
})
