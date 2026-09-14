import type postgres from 'postgres'
import { money, type Money } from '../money.js'

/**
 * What a tracking ref looks like, which is a uuid, because the cashier mints
 * `randomUUID()` and uses the same value as the row's id and as the sub-id
 * inside the URL (src/cashier.ts rule 5).
 */
export const TRACKING_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The ref as we will look it up, or null when the string we were sent cannot be
 * one of ours.
 *
 * Networks mangle. They lowercase parameters, they trim them to a field width,
 * and they round-trip them through systems that add whitespace. Two of those
 * three are recoverable here and the third is not, and the split is the point:
 * case and whitespace are normalised, and a TRUNCATED ref is refused rather
 * than resolved.
 *
 * Refusing the truncation is the decision worth stating. A prefix match would
 * "work" almost always and would attribute a booking to whichever click happens
 * to share the prefix the day two do, silently, forever, in the table the whole
 * module derives its numbers from. An unattributed conversion is a number we do
 * not have, and a wrongly attributed one is a number we believe.
 */
export function normalizeTrackingRef(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  return TRACKING_REF_PATTERN.test(trimmed) ? trimmed : null
}

/** A conversion we could not attach to exactly one click, with what was reported. */
export class UnattributableConversionError extends Error {
  constructor(readonly reported: string, detail: string) {
    super(`Cannot attribute a conversion reported against '${reported}': ${detail}`)
    this.name = 'UnattributableConversionError'
  }
}

/** One row as an affiliate network reports it, before we have resolved anything. */
export type ReportedConversion = {
  trackingRef: string
  supplier: string
  bookedAt: Date
  amountMinor: bigint
  currency: string
  commissionMinor: bigint
  reportedAt: Date
}

/** One row as this schema holds it, with the ids resolved off the click. */
export type Conversion = {
  id: string
  trackingRef: string
  linkClickId: string
  conversationId: string
  userId: string
  supplier: string
  bookedAt: Date
  amount: Money
  commission: Money
  reportedAt: Date
}

/**
 * Writes one reported booking, resolving every id off the click rather than off
 * the feed.
 *
 * ONE statement, an insert-select, and that shape is the whole defence. A read
 * followed by an insert would be two round trips with a window between them and
 * would take `user_id` from whatever the caller passed. This one takes it from
 * course.link_clicks and takes `conversation_id` from course.proposals, so a
 * feed cannot file a booking under a traveller who never saw the link. It also
 * means an unresolvable ref writes nothing rather than writing a row with a
 * guessed parent.
 *
 * Verified through `returning`, like every writer in this directory, and the
 * zero-row case is where the work is: the insert cannot say WHY it matched
 * nothing, so the refusal path does one diagnostic read to separate "no click
 * carries this ref" from "a click carries it and the reported supplier is not
 * the one we sent her to". Those are different faults with different owners,
 * and a single message covering both would send every investigation to the
 * wrong place half the time.
 */
export async function recordConversion(
  sql: postgres.Sql, reported: ReportedConversion,
): Promise<string> {
  const ref = normalizeTrackingRef(reported.trackingRef)
  if (ref === null) {
    throw new UnattributableConversionError(
      reported.trackingRef,
      'it is not a tracking ref this system mints. Refs are minted whole by the cashier '
      + 'and a truncated one is not resolved by prefix, because a prefix resolves to the '
      + 'wrong click the day two of them share it.',
    )
  }
  const rows = await sql<{ id: string }[]>`
    insert into course.conversions
      (tracking_ref, link_click_id, conversation_id, user_id, supplier,
       booked_at, amount_minor, currency, commission_minor, reported_at)
    select lc.tracking_ref, lc.id, p.conversation_id, lc.user_id, ${reported.supplier},
           ${reported.bookedAt}, ${reported.amountMinor.toString()}, ${reported.currency},
           ${reported.commissionMinor.toString()}, ${reported.reportedAt}
      from course.link_clicks lc
      join course.proposals p on p.id = lc.proposal_id
     where lc.tracking_ref = ${ref} and lc.supplier = ${reported.supplier}
    returning id`
  const row = rows[0]
  if (row) return row.id
  const [click] = await sql<{ supplier: string }[]>`
    select supplier from course.link_clicks where tracking_ref = ${ref}`
  throw new UnattributableConversionError(
    reported.trackingRef,
    click
      ? `we sent her to ${click.supplier} and the report names ${reported.supplier}`
      : 'no link we emitted carries that ref',
  )
}

/** A conversion beside the proposal it belongs to and the price we quoted her. */
export type AttributedConversion = Conversion & { proposalId: string; quoted: Money }

/**
 * Every booking reported for one traveller, newest first, with the number we
 * told her beside the number the network reported.
 *
 * Both amounts, always, because they answer different questions and 0013's
 * comment on `quoted_minor` says which: "the price we told her, at the moment
 * we told her ... module 7 compares a reported booking amount against this. It
 * is the number that cannot be added later." This function does not compare
 * them and does not flag a gap. It hands both to the caller, because what
 * counts as a gap worth acting on is a product decision and not a repository
 * one, and the currencies can honestly differ: a supplier may report in its own.
 *
 * Ordered by `seq desc`, never by `reported_at` and never by `booked_at`: rows
 * written by one feed batch share a transaction timestamp, and the two date
 * columns are the feed's facts rather than ours.
 */
export async function conversionsFor(
  sql: postgres.Sql, args: { userId: string; conversationId?: string },
): Promise<AttributedConversion[]> {
  const rows = await sql<{
    id: string; tracking_ref: string; link_click_id: string; conversation_id: string
    user_id: string; supplier: string; booked_at: Date; amount_minor: string
    currency: string; commission_minor: string; reported_at: Date
    proposal_id: string; quoted_minor: string; quoted_currency: string
  }[]>`
    select c.id, c.tracking_ref, c.link_click_id, c.conversation_id, c.user_id,
           c.supplier, c.booked_at, c.amount_minor, c.currency, c.commission_minor,
           c.reported_at, lc.proposal_id, lc.quoted_minor,
           lc.currency as quoted_currency
      from course.conversions c
      join course.link_clicks lc on lc.id = c.link_click_id
     where c.user_id = ${args.userId}
       ${args.conversationId ? sql`and c.conversation_id = ${args.conversationId}` : sql``}
     order by c.seq desc`
  return rows.map((r) => ({
    id: r.id,
    trackingRef: r.tracking_ref,
    linkClickId: r.link_click_id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    supplier: r.supplier,
    bookedAt: r.booked_at,
    amount: money(BigInt(r.amount_minor), r.currency),
    commission: money(BigInt(r.commission_minor), r.currency),
    reportedAt: r.reported_at,
    proposalId: r.proposal_id,
    quoted: money(BigInt(r.quoted_minor), r.quoted_currency),
  }))
}
