import { randomUUID } from 'node:crypto'
import { loadDesk } from '../src/desks.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

describe('a prompt edit at lesson-7-4', () => {
  it('produces exactly one prompt version, so every turn is in one arm', () => {
    // One file, one hash, one version on every row. Whatever the edit did, it
    // did it to everybody at once, and the only comparison available is
    // "before the deploy" against "after the deploy", which also contains
    // every other thing that changed that week.
    const versions = new Set([loadDesk('planning').promptVersion, loadDesk('planning').promptVersion])
    expect(versions.size).toBe(1)
  })
})

describeDb('and the rows cannot answer the question either', () => {
  it('has no way to compare two prompt versions, because there is only ever one live', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ prompt_version: string }[]>`
        select distinct prompt_version from course.model_calls
         where user_id = ${USER} and seat = 'driver'`
      // Nothing here, and nothing to compare, on a fresh traveller. The shape
      // of the problem is not that the data is missing: it is that a comparison
      // needs two arms and a deploy produces one.
      expect(rows).toEqual([])
    })
  })
})
