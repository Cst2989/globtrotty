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

/** One row as the caller sees it. Ordering and aggregation stay with the query. */
const toLink = (r: Row): EmittedLink => ({
  id: r.id,
  sourceId: r.item_id,
  supplier: r.supplier,
  url: r.url,
  trackingRef: r.tracking_ref,
  quoted: money(BigInt(r.quoted_minor), r.currency),
})

type Row = {
  id: string; item_id: string; supplier: string; url: string
  tracking_ref: string; quoted_minor: string; currency: string
  verified: boolean; quoted_at: Date
}

/**
 * Writes the links BEFORE they are returned, in one statement.
 *
 * This is the point of no return (src/cashier.ts, rule 6). After it, nothing
 * may mark the turn failed, nothing may re-quote that set, and everything else
 * is best effort: she may already be on a supplier's checkout page, and a
 * system that then tells her the request failed is describing a world she is
 * not in.
 *
 * What enforces it, exactly: `completeIfLinkEmitted` (src/worker.ts) reads this
 * table, and it is the only reader that decides how a turn ends. `runTurn`'s
 * catch calls it, `loop`'s four `failTurn` exits and `continueLater`'s cap arm
 * call it through `failTurnUnlessLinkEmitted`, and `src/sweeper.ts`'s crash arm
 * calls it as well, with a closer of its own, rather than carrying a second
 * copy of the decision in SQL. What does NOT read it: the two paths that
 * REQUEUE a turn rather than end it, `continueLater`'s hand-back and the
 * sweeper's requeue arm. Neither can re-emit against the same proposal
 * (`unique (proposal_id, item_id)`, and the cashier refuses a second hand-off
 * before it re-quotes), but a restarted turn that proposes again gets a new
 * proposal id, which that constraint does not cover. README.md carries it as a
 * named residual rather than as a claim that it is closed.
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
 * Read by `completeIfLinkEmitted` (src/worker.ts), which is what `runTurn`'s
 * catch, `loop`'s failing exits and the sweeper's crash arm all reach in order
 * to decide what to write about a turn that did not finish. `verified` and `quotedAt` both come
 * off the rows rather than being recomputed: recomputing `verified` would mean
 * re-quoting, which is precisely what rule 6 forbids after emission, and
 * recomputing the age from the clock would tell her a price quoted hours ago
 * was current just now. Between them they are everything `handOffMessage` needs
 * to say the same sentence again.
 *
 * Both are AGGREGATED over the turn, because a turn is not a hand-off: it may
 * have handed off twice, against two proposals and two suppliers. So the set is
 * verified only if every row in it is, and the age it discloses is the oldest
 * one, which is the same choice `handOffToBooking` makes for a single hand-off
 * (src/cashier.ts, the oldest `fetchedAt` in the set) and for the same reason:
 * the sentence states one age, and the honest one is the age of the stalest
 * number she is being shown.
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
    links: rows.map(toLink),
    // `every` over an empty array is true, so the length test is what keeps the
    // no-row case at `false`; those defaults are never read anyway, because
    // every caller checks `links.length` first.
    verified: rows.length > 0 && rows.every((r) => r.verified),
    quotedAt: rows.reduce<Date | null>(
      (oldest, r) => (oldest === null || r.quoted_at < oldest ? r.quoted_at : oldest), null),
  }
}

/**
 * Every link already emitted for one proposal, whichever turn emitted it.
 *
 * The cashier reads this before it re-quotes anything, so a second
 * `hand_off_to_booking` for the same proposal is refused rather than paid for:
 * rule 6 says a set that has been emitted may not be asked again, and
 * `unique (proposal_id, item_id)` would otherwise report that as a Postgres
 * error from inside the point of no return. Scoped by proposal and not by turn
 * on purpose: the model can call the tool again in a later turn, and the rows
 * it must not duplicate are the proposal's.
 */
export async function emittedForProposal(
  sql: postgres.Sql,
  proposalId: string,
): Promise<EmittedLink[]> {
  const rows = await sql<Row[]>`
    select id, item_id, supplier, url, tracking_ref, quoted_minor, currency, verified, quoted_at
      from course.link_clicks where proposal_id = ${proposalId} order by seq`
  return rows.map(toLink)
}
