import type postgres from 'postgres'
import { money, type Money } from '../money.js'

/** One link she was given, with the number she was given it at. */
export type EmittedLink = {
  id: string
  sourceId: string
  supplier: string
  url: string
  trackingRef: string
  quoted: Money
}

type Row = {
  id: string; item_id: string; supplier: string; url: string
  tracking_ref: string; quoted_minor: string; currency: string
  verified: boolean; quoted_at: Date
}

/**
 * Writes the links BEFORE they are returned, in one statement.
 *
 * This is the point of no return (spec §5, rule 6). After it, nothing may mark
 * the turn failed, nothing may re-quote that set, and everything else is best
 * effort: she may already be on a supplier's checkout page, and a system that
 * then tells her the request failed is describing a world she is not in.
 * `src/worker.ts`'s catch and `src/sweeper.ts`'s crash arm both check this
 * table before they write anything, which is what makes the rule enforceable
 * rather than a comment.
 *
 * One statement, so a crash cannot leave half a set of links. `id` is supplied
 * by the caller rather than defaulted by the column, because the id IS the
 * tracking ref embedded in each URL, so it has to exist before the URL does.
 *
 * The write is verified through `returning`, like every other writer in this
 * directory: a hand-off of three links that recorded two has already told her
 * about a link nothing in this system knows it emitted, and the whole of the
 * point-of-no-return rule is built on `emittedLinks` below being able to see
 * every link that went out. A partial write is therefore a failed write and
 * throws, which is `cashierRunner`'s ambiguous case rather than a silent one.
 */
export async function recordLinkClicks(
  sql: postgres.Sql,
  args: {
    proposalId: string
    turnId: string | null
    userId: string
    verified: boolean
    /** When these prices were quoted, so a recovered message can state their age. */
    quotedAt: Date
    links: EmittedLink[]
  },
): Promise<void> {
  if (args.links.length === 0) return
  const rows = args.links.map((l) => ({
    id: l.id,
    proposal_id: args.proposalId,
    turn_id: args.turnId,
    user_id: args.userId,
    item_id: l.sourceId,
    supplier: l.supplier,
    url: l.url,
    tracking_ref: l.trackingRef,
    quoted_minor: l.quoted.minor.toString(),
    currency: l.quoted.currency,
    verified: args.verified,
    quoted_at: args.quotedAt,
  }))
  const out = await sql`insert into course.link_clicks ${sql(rows)} returning id`
  if (out.length !== rows.length) {
    throw new Error(`recordLinkClicks: wrote ${out.length} of ${rows.length} rows`)
  }
}

/**
 * Every link this turn emitted, in the order it emitted them, whether they were
 * verified, and when their prices were quoted.
 *
 * Read by `runTurn`'s catch and by the sweeper before either decides what to
 * write about a turn that did not finish. `verified` and `quotedAt` both come
 * off the rows rather than being recomputed: recomputing `verified` would mean
 * re-quoting, which is precisely what rule 6 forbids after emission, and
 * recomputing the age from the clock would tell her a price quoted hours ago
 * was current just now. Between them they are everything `handOffMessage` needs
 * to say the same sentence again.
 *
 * Ordered by `seq`, not by `rendered_at`: every row lands in one statement and
 * shares one transaction timestamp, so a timestamp sort is unstable and the
 * links would come back to her in a different order than they were built in.
 */
export async function emittedLinks(
  sql: postgres.Sql,
  turnId: string,
): Promise<{ links: EmittedLink[]; verified: boolean; quotedAt: Date | null }> {
  const rows = await sql<Row[]>`
    select id, item_id, supplier, url, tracking_ref, quoted_minor, currency, verified, quoted_at
      from course.link_clicks where turn_id = ${turnId} order by seq`
  return {
    links: rows.map((r) => ({
      id: r.id,
      sourceId: r.item_id,
      supplier: r.supplier,
      url: r.url,
      trackingRef: r.tracking_ref,
      quoted: money(BigInt(r.quoted_minor), r.currency),
    })),
    // Every row of one hand-off carries the same value for both of these, so
    // the first row is the answer; the no-row defaults are never read, because
    // every caller checks `links.length` first.
    verified: rows[0]?.verified ?? false,
    quotedAt: rows[0]?.quoted_at ?? null,
  }
}
