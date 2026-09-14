import type postgres from 'postgres'
import type { ScorecardRow } from '../evals/scorecard.js'

/** One seat, and what it cost to hire it. */
export type SeatRow = {
  seat: string
  calls: number
  turns: number
  conversations: number
  costMicros: bigint
}

/**
 * Micros of USD as dollars, in integer arithmetic, to four places.
 *
 * Four and not two, because a Haiku call on this branch costs less than a cent
 * and a report that rounded it to $0.00 would say the cheap seats are free,
 * which is the exact conclusion this report exists to let somebody argue with.
 * No float anywhere: money is bigint on this branch and a report is not the
 * place to stop believing that.
 */
export function usd(micros: bigint): string {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n) / 100n
  return `${negative ? '-' : ''}$${whole}.${String(frac).padStart(4, '0')}`
}

/**
 * Cost and calls grouped by seat, which is SPEC section 1's whole measurement
 * mandate in one query: "we hired seven architectures, measured them, and fired
 * three".
 *
 * Four numbers per seat and not one. Cost alone says the driver is expensive,
 * which everybody knew. Cost beside calls says what one call costs. Both beside
 * turns and conversations say what one TURN costs at that seat, which is the
 * number a decision to retire a seat is actually made on, because a seat that
 * is cheap per call and runs forty times a turn is not a cheap seat.
 *
 * `count(distinct turn_id)` ignores the nulls Postgres leaves out of a distinct
 * count, and that is correct here rather than convenient: `course.model_calls`
 * allows a null turn id for a call made before a turn exists (0002), and those
 * calls are real calls at a real cost that belong to no turn.
 *
 * Ordered by cost descending, so the seat a reader has to argue about is the
 * first line.
 *
 * This function READS `cost_micros` and sums it; it never moves it.
 * `recordSpend`, `ledgerSink`, `reserve` and `reconcile` are the four functions
 * that write it (README's residual pass names them), and this is a fifth
 * reader beside `turnSpendMicros`, not a sixth writer.
 */
export async function seatReport(
  sql: postgres.Sql, args: { userId?: string } = {},
): Promise<SeatRow[]> {
  const rows = await sql<{
    seat: string; calls: number; turns: number; conversations: number; cost_micros: string
  }[]>`
    select seat,
           count(*)::int as calls,
           count(distinct turn_id)::int as turns,
           count(distinct conversation_id)::int as conversations,
           coalesce(sum(cost_micros), 0)::text as cost_micros
      from course.model_calls
     ${args.userId ? sql`where user_id = ${args.userId}` : sql``}
     group by seat
     order by coalesce(sum(cost_micros), 0) desc, seat`
  return rows.map((r) => ({
    seat: r.seat,
    calls: r.calls,
    turns: r.turns,
    conversations: r.conversations,
    costMicros: BigInt(r.cost_micros),
  }))
}

/**
 * The report, as a reader sees it.
 *
 * The gate rows are passed IN rather than queried here, and they come from
 * `gateMetrics` (src/evals/gateMetrics.ts, lesson 6.2), which is already the
 * one reader of `course.gate_results` on this branch. A second query for the
 * same verdicts would be the duplicate-reader half of the defect lesson 7.1
 * pinned as a grep, in the lesson that closes the course.
 *
 * A seat with no rows does not appear. That is deliberate and it is the one
 * thing a reader has to know to read this: `titler` is a name the schema
 * accepts (0014) and nothing on this branch writes, so its absence here is the
 * report saying we never hired it rather than the report losing it.
 */
export function renderSeatReport(
  rows: readonly SeatRow[], gates: readonly ScorecardRow[],
): string {
  const width = Math.max(10, ...rows.map((r) => r.seat.length))
  const seats = rows.map((r) =>
    `  ${r.seat.padEnd(width)}  ${String(r.calls).padStart(6)} calls`
    + `  ${String(r.turns).padStart(5)} turns`
    + `  ${usd(r.costMicros).padStart(12)}`
    + `  ${usd(r.turns === 0 ? 0n : r.costMicros / BigInt(r.turns)).padStart(12)} per turn`)
  const total = rows.reduce((sum, r) => sum + r.costMicros, 0n)
  return [
    'seats hired, and what each one cost',
    ...seats,
    `  ${'total'.padEnd(width)}  ${' '.repeat(13)}${' '.repeat(12)}${usd(total).padStart(12)}`,
    '',
    'and what the gates said about the work',
    ...gates.map((g) => `  ${g.name}  ${g.tally.passed} passed, ${g.tally.failed} failed, `
      + `${g.tally.notEvaluated} not evaluated`),
  ].join('\n')
}

/**
 * How many labelled routing decisions this branch holds, against how many a
 * fine-tune would need.
 *
 * A thousand, and the number is a floor rather than a target. Arize's write-up
 * of Booking.com's fine-tuned intent model is a case study about thousands of
 * labelled examples, so a thousand is the order of magnitude below which the
 * question does not arise. Written here rather than in a lesson, so the
 * decision and the number cannot drift apart.
 *
 * `corrected` is counted separately and is zero on this branch, and that is the
 * more important of the two numbers. A corpus of the classifier's own
 * unreviewed outputs is a corpus of the classifier agreeing with itself, and
 * training on it teaches the next model to make the same mistakes with more
 * confidence. There is no correction path on this branch: nothing lets a person
 * say the router chose wrong, so `corrected` has no writer and the field says
 * so rather than being left out.
 *
 * Counting this corpus is not training it. Nothing here calls a fine-tuning
 * API, moves a weight or writes a model file; the whole function is a `select
 * count(*)`, and the decision it feeds, reconsider or do not fine-tune, is a
 * person's, made with a number in front of them rather than a model this course
 * shipped.
 */
export const FINE_TUNE_MINIMUM = 1000

export type FineTuneCorpus = {
  labelled: number
  corrected: number
  minimum: number
  enough: boolean
}

export async function fineTuneCorpus(
  sql: postgres.Sql, args: { userId?: string } = {},
): Promise<FineTuneCorpus> {
  const [row] = await sql<{ labelled: number }[]>`
    select count(*)::int as labelled
      from course.conversations c
     where c.desk is not null
       and exists (select 1 from course.messages m
                    where m.conversation_id = c.id and m.role = 'user')
       ${args.userId ? sql`and c.user_id = ${args.userId}` : sql``}`
  const labelled = row?.labelled ?? 0
  return { labelled, corrected: 0, minimum: FINE_TUNE_MINIMUM, enough: labelled >= FINE_TUNE_MINIMUM }
}
