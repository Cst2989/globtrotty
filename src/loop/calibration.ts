import type postgres from 'postgres'
import { judgeAgreement, type Agreement, type Labelled } from '../evals/judge.js'

/** One labelled proposal with the day she decided it, which is what buckets a series. */
export type DatedLabelled = Labelled & { decidedAt: Date }

/** One month's agreement between the judge and her own decisions. */
export type AgreementPoint = { month: string; agreement: Agreement }

/**
 * Judge agreement per calendar month, oldest first.
 *
 * A standing job rather than a one-off check, because that is what P4 asks for
 * and because a single agreement figure answers a question nobody has: the
 * instrument was calibrated once, at a moment, against the proposals that
 * existed then. What a reader needs to see is whether it is still calibrated,
 * and a series is the only shape that can say so.
 *
 * Each month is passed to `judgeAgreement` (src/evals/judge.ts, lesson 6.6)
 * rather than being counted here. There is one definition of agreement on this
 * branch and one floor under it, and a second arithmetic that happened to agree
 * today is a second arithmetic that will not agree in six months.
 *
 * UTC months, spelled from the date's own UTC parts, for the reason
 * src/repo/spend.ts gives about the UTC day: a bucket boundary that depends on
 * the reader's time zone puts the same proposal in two different months
 * depending on who ran the query.
 */
export function agreementSeries(rows: readonly DatedLabelled[]): AgreementPoint[] {
  const byMonth = new Map<string, Labelled[]>()
  for (const row of rows) {
    const month = `${row.decidedAt.getUTCFullYear()}-${String(row.decidedAt.getUTCMonth() + 1).padStart(2, '0')}`
    byMonth.set(month, [...(byMonth.get(month) ?? []), row])
  }
  return [...byMonth]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, labelled]) => ({ month, agreement: judgeAgreement(labelled) }))
}

/** Proposals made under one prompt version, and how many of them she booked. */
export type ConversionByVersion = { promptVersion: string; proposals: number; conversions: number }

/**
 * The verdict a release canary is actually judged by.
 *
 * Not the eval score, and the difference is this lesson's point. The suite says
 * whether the change broke anything we know how to check. This says whether the
 * people who got it booked more trips, and when those two disagree the users
 * win, because the evals passed and the users voted.
 *
 * Joined through the turn: a proposal carries `turn_id`, the driver's
 * `course.model_calls` rows for that turn carry `prompt_version`, and the
 * booking is `course.conversions` reached through `course.link_clicks`. Nothing
 * new is stored, which is why this lesson needs no migration.
 *
 * `count(distinct ...)` on both sides because a turn has many driver calls and
 * a proposal has many links, and the question is about trips rather than about
 * rows. LEFT JOIN on both, so a prompt version with proposals and no bookings
 * is a row that says zero rather than a row that is missing: a rate that drops
 * arms when they fail is a rate that improves every time something breaks.
 */
export async function conversionByPromptVersion(
  sql: postgres.Sql, args: { userId: string },
): Promise<ConversionByVersion[]> {
  const rows = await sql<{ prompt_version: string; proposals: number; conversions: number }[]>`
    select mc.prompt_version,
           count(distinct p.id)::int as proposals,
           count(distinct c.id)::int as conversions
      from course.proposals p
      join course.model_calls mc
        on mc.turn_id = p.turn_id and mc.user_id = p.user_id and mc.seat = 'driver'
      left join course.link_clicks lc on lc.proposal_id = p.id
      left join course.conversions c on c.link_click_id = lc.id
     where p.user_id = ${args.userId}
     group by mc.prompt_version
     order by mc.prompt_version`
  return rows.map((r) => ({
    promptVersion: r.prompt_version, proposals: r.proposals, conversions: r.conversions,
  }))
}
