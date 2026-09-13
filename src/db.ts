import postgres from 'postgres'

/**
 * Every table this course creates lives in its own schema, so the branch can
 * point at a database that already holds other tables without colliding with
 * them. The migrations and every query spell the name out.
 */
export const SCHEMA = 'course'

/**
 * The one way this codebase opens a connection. There is no `search_path`
 * setting here on purpose: the course qualifies every table with the `course`
 * schema itself, so the product's own tables in `public` are never touched and
 * the reader's project keeps a clean namespace. Nothing depends on a startup
 * parameter either, so a transaction-mode pooler works exactly like a direct
 * connection.
 */
export function connect(url: string, max = 5): postgres.Sql {
  return postgres(url, {
    max,
    onnotice: () => {},
  })
}

/**
 * The connection a query that touches a traveller's own rows is meant to open.
 *
 * The same `postgres` options `connect` uses, and one difference that is the
 * whole lesson: the session is put into the `course_worker` role, so the
 * policies `0017` wrote are the ones that decide what a query returns. A query
 * that forgets its `and user_id =` clause comes back empty here and comes back
 * with everybody's rows through `connect`.
 *
 * `connect` stays, and stays used: `scripts/migrate.ts` needs the owner to run
 * DDL at all, and `src/repo/spend.ts`'s global ceiling has to sum
 * `course.daily_usage` across every user, which is exactly what a per-user
 * policy would break. Two connections, two jobs, and the migration says why.
 *
 * The role is set through a startup parameter here AND again inside `withUser`,
 * which is not redundancy for its own sake. This one is what a caller gets even
 * if it never opens a transaction; that one is what a caller gets even if it was
 * handed an owner pool by mistake. It is also the one line in this file that a
 * transaction-mode pooler can refuse, since `connect`'s docstring above makes a
 * point of depending on no startup parameter at all, and that is the reason
 * `withUser` does not rely on it.
 */
export function connectAsWorker(url: string, max = 5): postgres.Sql {
  return postgres(url, {
    max,
    onnotice: () => {},
    // Per CONNECTION and not per transaction, because the role is what the
    // pool hands out and the identity is what `withUser` sets on top of it.
    connection: { options: '-c role=course_worker' },
  })
}

/**
 * Runs `fn` inside one transaction that has said who it is.
 *
 * `set local`, not `set`. `set local` is released when the transaction ends, so
 * a pooled connection cannot hand the next caller the previous caller's
 * identity, which is a worse bug than the one this lesson is fixing: it would
 * show one traveller another traveller's rows under a system that reads as
 * secure. `set_config(..., true)` rather than a `set local` statement, because
 * the value is a parameter and a `set` statement cannot take one, and building
 * that statement by interpolation would put a user id into SQL text.
 *
 * The role is set here as well as on the connection, so a caller that was handed
 * an owner connection by mistake still reads under the policies rather than
 * around them. Fail closed at both ends.
 *
 * One transaction is also the bound on what may be done inside it, and that is
 * why this is not wrapped around a whole turn. A turn on tier 3 runs for up to
 * fourteen minutes, its heartbeat has to be visible to the sweeper WHILE it
 * runs, and `course.link_clicks` rows have to be committed before the model is
 * handed the URLs built from them (src/cashier.ts, rule 6). All three of those
 * are properties of a committed row, and a turn held open in one transaction has
 * none of them. What belongs in here is a unit of work short enough to commit:
 * a read, a write, or a group of writes that already share a transaction.
 */
export async function withUser<T>(
  sql: postgres.Sql, userId: string, fn: (tx: postgres.TransactionSql) => Promise<T> | T,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role course_worker`
    await tx`select set_config('course.user_id', ${userId}, true)`
    return fn(tx)
  }) as Promise<T>
}
