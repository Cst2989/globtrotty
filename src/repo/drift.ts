import type postgres from 'postgres'
import type { DriftAlarm } from '../notify.js'
import type { CanarySeat } from '../monitor/drift.js'

export type Band = 'xs' | 's' | 'm' | 'l' | 'xl'

/**
 * One fingerprinted canary call, as stored in `canary_runs` (migration 0015).
 * Never content — a response shape summary, so a drift alarm's `detail` can
 * be logged and read without replaying anything a model said.
 */
export type CanaryRun = {
  seat: CanarySeat; model: string; stopReason: string; outputBand: Band
  signal: string; requestId: string | null
}

/**
 * The fixed uuid the drift monitor charges instead of a traveller. Defined
 * here — not in `src/monitor/drift.ts`, despite that being where the plan's
 * interface list names it — so `ensureOpsConversation` below can use it
 * without a runtime import back from `monitor/drift.ts` (which imports this
 * module's functions). `monitor/drift.ts` re-exports it, so every consumer
 * described in the plan can still `import { OPS_USER_ID } from
 * '../monitor/drift.js'`.
 */
export const OPS_USER_ID = '00000000-0000-4000-8000-00000000000f'

export async function recordCanaryRun(sql: postgres.Sql, run: CanaryRun): Promise<void> {
  await sql`
    insert into canary_runs (seat, model, stop_reason, output_band, signal, request_id)
    values (${run.seat}, ${run.model}, ${run.stopReason}, ${run.outputBand}, ${run.signal}, ${run.requestId})`
}

/**
 * The most recent stored run for this seat, or null on the first ever run.
 *
 * `order by ran_at desc limit 1` is load-bearing, not decorative: without it,
 * once a seat has more than one row, which one comes back is whatever order
 * Postgres happens to scan them in — usually insertion order on a small
 * table, which is the WRONG row the moment an out-of-order or backfilled
 * `ran_at` exists. `diffCanary` is only comparing against "the run before
 * this one" if this query actually returns that row.
 */
export async function previousCanaryRun(sql: postgres.Sql, seat: CanarySeat): Promise<CanaryRun | null> {
  const rows = await sql<{
    seat: CanarySeat; model: string; stop_reason: string; output_band: Band
    signal: string; request_id: string | null
  }[]>`
    select seat, model, stop_reason, output_band, signal, request_id
      from canary_runs
     where seat = ${seat}
     order by ran_at desc
     limit 1`
  const row = rows[0]
  if (row === undefined) return null
  return {
    seat: row.seat, model: row.model, stopReason: row.stop_reason,
    outputBand: row.output_band, signal: row.signal, requestId: row.request_id,
  }
}

export async function recordAlarm(
  sql: postgres.Sql,
  a: { seat: string; check: 'canary' | 'shape'; detail: Record<string, unknown> },
): Promise<DriftAlarm> {
  const rows = await sql<{ id: string; seat: string; check: string; detail: unknown; created_at: Date }[]>`
    insert into drift_alarms (seat, "check", detail)
    values (${a.seat}, ${a.check}, ${sql.json(a.detail as never)})
    returning id, seat, "check", detail, created_at`
  const row = rows[0]!
  return {
    id: row.id, seat: row.seat, check: row.check as 'canary' | 'shape',
    detail: row.detail as Record<string, unknown>, createdAt: row.created_at,
  }
}

/** Best-effort stamp, like `markNotified` for escalations — the caller swallows a failure here. */
export async function markAlarmNotified(sql: postgres.Sql, id: string): Promise<void> {
  await sql`update drift_alarms set notified_at = now() where id = ${id} and notified_at is null`
}

/**
 * The full (unreduced) `request_shape` from the newest REAL `model_calls`
 * row for this seat — `capture_policy` writes NULL for a truncated/
 * sampled-out row (src/repo/modelCalls.ts), and this is scoped to the three
 * seats that are always `'full'`, so `is not null` is really "the newest
 * row", but stated explicitly rather than assumed.
 *
 * `and user_id <> OPS_USER_ID` is load-bearing, not decorative: every canary
 * call itself writes a `model_calls` row via `buildRequest(goldenArgs(seat))`
 * — the EXACT thing this check compares against — so without this exclusion
 * a seat's own most recent canary run would always be "the newest row" after
 * the very first nightly run ever executes, and the shape check would
 * silently stop being able to see real production drift for the rest of
 * that seat's history (comparing goldenArgs against itself always matches).
 * Excluding the ops user is what keeps this check looking at what real
 * traffic actually sent.
 */
export async function newestRequestShape(
  sql: postgres.Sql, seat: 'driver' | 'reviewer' | 'front_desk',
): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ request_shape: unknown }[]>`
    select request_shape from model_calls
     where seat = ${seat} and request_shape is not null and user_id <> ${OPS_USER_ID}
     order by created_at desc
     limit 1`
  const row = rows[0]
  if (row === undefined) return null
  return row.request_shape as Record<string, unknown>
}

/** `ops:YYYY-MM`, UTC — the month bucket `ensureOpsConversation` scopes to. */
function opsTitleFor(now: Date): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `ops:${year}-${month}`
}

/**
 * The ops conversation this UTC month's canary calls reserve/reconcile/
 * record against, so their counters never touch a traveller's. Scoped to
 * the calendar month (`title = 'ops:YYYY-MM'`) rather than one conversation
 * reused for the monitor's entire lifetime: `conversations.spend_usd_micros`
 * only ever grows, so a lifetime-reused row eventually crosses
 * `conversationCeilingMicros` permanently and every canary call from then on
 * skips forever — a self-inflicted, un-recoverable trap with no code path
 * that ever resets it. A fresh conversation each UTC month resets that
 * counter on a schedule nothing has to notice or act on.
 *
 * ACCEPTED RACE: two monitor runs invoked concurrently near a month boundary
 * (or by any accidental double-trigger) could both see no existing row for
 * the new month and each insert one. That is accepted, not fixed here: at
 * worst it splits one month's ops spend across two rows, which is cosmetic
 * — nothing reads "the" ops conversation as a lifetime singleton, it exists
 * only to give `reserve` a row to charge — never a money-safety or
 * correctness issue, since each row's own ceiling still independently gates
 * the calls charged to it. The monitor is a single nightly cron invocation;
 * this repo does not defend `ensureOpsConversation` against the class of
 * duplicate-insert race a genuinely concurrent scheduler could someday cause.
 */
export async function ensureOpsConversation(sql: postgres.Sql, now: Date): Promise<string> {
  const title = opsTitleFor(now)
  const existing = await sql<{ id: string }[]>`
    select id from conversations
     where user_id = ${OPS_USER_ID} and title = ${title}
     order by created_at desc limit 1`
  const row = existing[0]
  if (row !== undefined) return row.id
  const created = await sql<{ id: string }[]>`
    insert into conversations (user_id, desk, title) values (${OPS_USER_ID}, 'planning', ${title}) returning id`
  return created[0]!.id
}
