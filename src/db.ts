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
