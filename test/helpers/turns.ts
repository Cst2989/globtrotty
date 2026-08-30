import type postgres from 'postgres'
import { DEFAULT_LIMITS } from '../../src/limits.js'

/**
 * The deps object `submitMessage` takes, which every database test that needs a
 * turn to exist has to build before it can do anything else. One copy, for the
 * same reason `test/helpers/worker.ts` holds one `WorkerDeps`: a literal copied
 * into a dozen files is a dozen places to forget whatever the thirteenth one
 * learns, and the copies had already started to differ in field order alone.
 */
export const handlerDeps = (sql: postgres.Sql) =>
  ({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} })

/**
 * Silence, made to have happened, by moving the last heartbeat into the past.
 * Every lease, claim, completion and worker test ages a turn this way: inside
 * `withTestDb` every `now()` is the one transaction timestamp, so actually
 * waiting HEARTBEAT_STALE seconds would not move the row's age at all.
 */
export async function silentFor(sql: postgres.Sql, turnId: string, seconds: number): Promise<void> {
  await sql`update course.turns
               set heartbeat_at = now() - make_interval(secs => ${seconds})
             where id = ${turnId}`
}
