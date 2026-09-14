/**
 * The eval runner. Keyless by design, and it needs a database:
 *
 *   npm run evals
 *
 * What it grades from lesson 6.3 is three golden cases (`evals/golden-trips.json`),
 * each one a whole conversation driven end to end with nobody typing: the
 * scripted traveller (src/evals/sim-user.ts) answers from her persona's facts,
 * the real handler and the real worker do the work, and every model response
 * comes off a recording, so a reader with no key runs the same three
 * conversations the author recorded. Until this lesson it graded two worlds the
 * mock supplier produced from two seeds and a reply written into a constant,
 * which is not an eval of an agency.
 *
 * It may exit 1, on purpose, and at this tag it does. A check that reached a
 * verdict and failed is the run going red; the nulls leave the exit code alone,
 * which is the whole argument for a third value: a property nobody could reach
 * has not failed.
 *
 * The database half is the gate section. It reads course.gate_results, which is
 * where the production checks record every verdict they reach, so the card
 * carries the gates' own numbers beside the graded ones rather than a second
 * set computed here. It is asked for each case's own user id and the rows are
 * summed, so the `gate:` rows are this run's gates and nobody else's. The gate
 * rows do not decide the exit code: a gate that refused a bad proposal is the
 * system working, and reddening the run for it would teach a reader that a red
 * gate row is noise.
 *
 * From lesson 6.4 every input a case has is chosen by this file rather than read
 * off a module constant. Four of them, and the fourth is pinned to the wrong
 * thing:
 *
 *  - the calendar is the suite's own, `EVAL_TODAY` and never `TODAY`, and it
 *    reaches the planning desk's `{{today}}` as well as the dates gate, because
 *    a calendar pinned on one of those and not the other is worse than none;
 *  - domain time is fixed at `evalNow()`, which is both the instant the mock
 *    suppliers stamp `fetchedAt` with and the instant the gates age those items
 *    against. Elapsed time is not pinned and cannot be: the invocation deadline
 *    and the `latency_ms` of both seats an eval calls measure how long this
 *    process really worked (`invocationClock`, src/evals/conversation.ts);
 *  - the budget is `EVAL_LIMITS` rather than production's;
 *  - the supplier world is `RECORDED_WORLD_SEED` and NOT `seedFor(kase.id)`.
 *    That one is the lesson's own outstanding bill: these three cases replay
 *    recordings whose `propose_trip` names the source ids of the world they were
 *    recorded in, so a case cannot run in a world of its own until it is
 *    re-recorded there. Written up at that constant and in README's residuals.
 *
 * `--runs 3` then runs every case three times and prints a `pass^k:` row per
 * case with k as its denominator, so a case that passes twice out of three is
 * named as flaky rather than averaged into a rate. One run by default, because
 * k=1 is not a measurement and the per-PR run should not pay for one. On a
 * replayed run nothing about the model moves, so a flaky line here would be a
 * finding about this suite rather than about the desk.
 *
 * ## What a run leaves behind
 *
 * This script connects to the reader's real DATABASE_URL, and `deleteRunRows`
 * below removes everything a pass wrote, daily_usage included, once the card
 * is printed. DURING a run the rows are real.
 * The money is simulated and the ledger is not: every replayed call is priced
 * from the usage in its recording and debited through `reserve` and `reconcile`
 * like a real one, so a pass spends nothing at the provider and still writes
 * real rows against the $50 cross-user day that `npm run trip` shares. The three
 * cases were measured at $0.62, $0.57 and $0.99, so a pass is worth about $2.18
 * of that day and `--runs 3` about $6.53. Lesson 6.6's nightly
 * schedule is sixty conversations a night against the same ceiling.
 *
 * From lesson 6.5 the card reaches a verdict on the PATH as well as on the
 * answer. `every_number_has_a_search`, `questions_before_guesses` and
 * `announced_work_was_done` are read off the rows the system already wrote, and
 * the two lines under the card are rates with their denominators: how many of
 * this run's turns carry a label row in `course.turn_labels`, and how many of
 * the amounts the agency put in prose match a price its own corpus holds.
 *
 * From lesson 6.6 the run is one of the three entries in `evals/schedule.ts`,
 * chosen with `--schedule <name>` and defaulting to `per-pr`. The entry decides
 * the case selection, the run count, whether the path sections run and whether
 * the JUDGE runs. `per-pr` is the default and its `judge` is false, so
 * `npm run evals` stays keyless and needs only `DATABASE_URL`, which is what
 * keeps this a proof command a reader can run. The judge lives on the nightly
 * run: `--schedule nightly` calls a model per decided proposal and needs a key
 * and a billed account, and it is the run whose agreement line says whether the
 * judge is deployable at all.
 *
 * `--runs` stays and overrides the schedule's own count, so a reader can ask for
 * three runs of the per-PR selection without editing the table.
 *
 * The judge section bills like any other eval conversation and is bounded like
 * one. It mints a `randomUUID()` user and a conversation of its own, and
 * `runJudge` reserves and reconciles against it under `EVAL_LIMITS`, so the
 * conversation, daily and global ceilings all see a nightly pass and a pass that
 * reaches one stops rather than spending past it. It also replays the gates at
 * most once per proposal, through `replayGatesOnce`, because a cron that came
 * back every night would otherwise write a fresh round-1 `course.gate_results`
 * row set per proposal per night.
 *
 * `replayClient` comes from `test/`, which is the one place this runner reaches
 * into that directory. It is the branch's only keyless model client and a copy
 * under `src/` would be two clients to keep in step, so `tsconfig.json` compiles
 * both roots and the import is legal.
 *
 * IT WRITES. From lesson 6.3 this command drives three whole conversations
 * through the real handler and the real worker against a real connection with no
 * transaction, so it commits conversations, turns, messages, tool results,
 * proposals, gate results and model calls under three fresh user ids. It deletes
 * them again at the end, children first, by the ids it minted, which is
 * `withRealDb`'s pattern (test/helpers/db.ts) applied to a script that has no
 * test harness to roll it back. The gate numbers are read BEFORE the delete,
 * because they are read out of the rows this run wrote.
 */
import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import { config } from 'dotenv'
import type postgres from 'postgres'
import { liveClient } from '../src/client.js'
import { connect } from '../src/db.js'
import { fixtureFor, loadGoldenCases } from '../src/evals/cases.js'
import { gateMetrics, gateRows } from '../src/evals/gateMetrics.js'
import type { Grade } from '../src/evals/grade.js'
import {
  AGREEMENT_FLOOR, judgeAgreement, judgeContext, JudgeCappedError, runJudge, type Labelled,
} from '../src/evals/judge.js'
import { replayGatesOnce } from '../src/evals/replay.js'
import { runCase } from '../src/evals/runner.js'
import { renderScorecard, scorecardOf, withRows, type ScorecardRow } from '../src/evals/scorecard.js'
import { conversionByPromptVersion } from '../src/loop/calibration.js'
import { RELEASE } from '../src/loop/release.js'
import { GOLDEN_UNCHANGED_FLOOR, survivalScores } from '../src/loop/similarity.js'
import { decidedProposals } from '../src/repo/proposals.js'
import { readTurnLabels } from '../src/repo/turnLabels.js'
import { makeSimulatedUser } from '../src/evals/sim-user.js'
import { casePassed, evalNow, passAtK, passAtKRows, EVAL_TODAY, RECORDED_WORLD_SEED } from '../src/evals/variance.js'
import { EVAL_LIMITS } from '../src/limits.js'
import { replayClient } from '../test/model/replay.js'
import { SCHEDULE, sectionsFor, selectionFor, type ScheduleName } from './schedule.js'

// The guard is scripts/demo.ts's, word for word: two scripts giving different
// advice about the same missing variable is how a reader learns to ignore both.
config({ path: '.env.local', override: false })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

/**
 * The value after a flag, or undefined when the flag is absent. Read off argv
 * rather than through a flag library, because there are two of them.
 *
 * A flag present with NOTHING after it exits 1 rather than reading as absent.
 * `npm run evals -- --schedule` is somebody asking for a schedule and not
 * saying which, and silently running the default under it is the same defect
 * the unknown-name guard below refuses: a card printed under a selection and a
 * run count its operator did not choose.
 */
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value after it.`)
    process.exit(1)
  }
  return value
}

/**
 * `npm run evals -- --schedule nightly`. The per-PR entry by default, because
 * it is the one that runs keyless and the one COURSE SPEC's proof command
 * names.
 *
 * An unknown name exits 1 rather than falling back to the default. A run that
 * silently graded the per-PR selection while its operator believed it was the
 * nightly one would report a score under the wrong denominator, with no judge
 * and no sign that anything was missing.
 */
const scheduleArg = flag('--schedule') ?? 'per-pr'
if (!Object.hasOwn(SCHEDULE, scheduleArg)) {
  console.error(`Unknown --schedule ${scheduleArg}. One of: ${Object.keys(SCHEDULE).join(', ')}.`)
  process.exit(1)
}
const SCHEDULED = SCHEDULE[scheduleArg as ScheduleName]

/**
 * `npm run evals -- --runs 3`, overriding the schedule's own count, so a reader
 * can ask for three runs of the per-PR selection without editing the table.
 *
 * A value that is not a number, or is zero, falls back to one rather than
 * running the suite NaN times. Absent, the schedule decides: pass^k over k=1 is
 * not a measurement, and the per-PR entry is the one that says so by asking for
 * one run.
 */
const runsArg = flag('--runs')
const RUNS = runsArg === undefined
  ? SCHEDULED.runs
  : Math.max(1, Math.trunc(Number(runsArg)) || 1)

/**
 * Deletes everything this run wrote, by the ids this run minted, children first.
 *
 * The order and the reasoning are `withRealDb`'s (test/helpers/db.ts), because
 * this is the same problem: a real commit with no transaction to roll back.
 * `course.agent_events.turn_id` is `on delete set null` (migration 0017), so
 * those rows outlive the turn that wrote them and have to go before it.
 * `course.source_memory` is deliberately absent rather than forgotten: a fact
 * about a property belongs to nobody (migration 0016), so there is no user id to
 * delete it by, and nothing on this path writes one.
 *
 * A failure here is logged and swallowed. Some rows left behind are cheaper than
 * a proof command that reports a scorecard and then exits on a delete, and the
 * scorecard is already printed by the time this runs.
 */
async function deleteRunRows(sql: postgres.Sql, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  try {
    await sql`delete from course.model_calls where user_id = any(${userIds})`
    await sql`delete from course.link_clicks where user_id = any(${userIds})`
    await sql`delete from course.proposals where user_id = any(${userIds})`
    await sql`delete from course.gate_results where user_id = any(${userIds})`
    await sql`delete from course.tool_results where user_id = any(${userIds})`
    await sql`delete from course.user_memory where user_id = any(${userIds})`
    await sql`delete from course.agent_events where user_id = any(${userIds})`
    await sql`delete from course.messages where user_id = any(${userIds})`
    await sql`delete from course.turns where user_id = any(${userIds})`
    await sql`delete from course.conversations where user_id = any(${userIds})`
    await sql`delete from course.daily_usage where user_id = any(${userIds})`
  } catch (err) {
    console.error(`the eval run could not delete its own rows: ${String(err)}`)
  }
}
const SECTIONS = sectionsFor(SCHEDULED)

async function main(): Promise<void> {
  const cases = selectionFor(SCHEDULED.name, loadGoldenCases())
  console.log(`schedule ${SCHEDULED.name}: ${cases.length} cases, ${RUNS} run(s) each, `
    + `sections ${SECTIONS.length > 0 ? SECTIONS.join(' and ') : 'none'}`)
  const graded: { caseId: string; grades: Grade[] }[] = []
  const evalUsers: string[] = []
  // One entry per run that finished, carrying the three things the rate section
  // below needs. A run that threw adds nothing, so the turn count is the turns
  // of the runs that produced any, which is the denominator those rates mean.
  const evalRuns: { conversationId: string; userId: string; turnIds: string[] }[] = []
  const runs = new Map<string, boolean[]>()
  const sql = connect(process.env.DATABASE_URL!, 2)
  try {
    for (const kase of cases) {
      for (let i = 0; i < RUNS; i += 1) {
        const client = replayClient(fixtureFor(kase.id))
        try {
          const result = await runCase(
            {
              sql, client,
              limits: EVAL_LIMITS, simUser: makeSimulatedUser,
              // Every input this case has, pinned by the caller: one world,
              // one calendar for the suite, one instant for the gates. The
              // world is the RECORDED one and not `seedFor(kase.id)`, for the
              // reason written at that constant: these three cases replay
              // responses that name the ids of the world they were recorded in.
              seed: RECORDED_WORLD_SEED, now: evalNow, today: EVAL_TODAY,
            },
            kase,
          )
          // The id FIRST, and `done()` after it. A drifted fixture is exactly the
          // case a developer runs over and over, so it is the worst one to leak
          // rows on, and `done()` below is a throw: anything after it is skipped
          // and `deleteRunRows` never learns this id.
          evalUsers.push(result.userId)
          // The other half of a replay. `done()` reports recorded calls that were
          // never used, which is how a drifted fixture announces itself, and it
          // throws into the same catch, so a drifted run is a case that did not
          // complete rather than a card printed over an unfinished recording.
          client.done()
          evalRuns.push({
            conversationId: result.conversationId, userId: result.userId,
            turnIds: result.trace.turnIds,
          })
          // Suffixed only when there is more than one run, because `scorecardOf`
          // counts one entry per graded case and three runs of one case are
          // three graded cases. At the default the id is the golden file's own,
          // which is what the FAIL lines and the residuals quote. The pass^k
          // rows below are where several runs are put back together under one id.
          graded.push({
            caseId: RUNS > 1 ? `${result.caseId}#${i}` : result.caseId,
            grades: result.grades,
          })
          runs.set(kase.id, [...(runs.get(kase.id) ?? []), casePassed(result)])
        } catch (err) {
          // Counted in casesExpected and not in casesGraded, and named on the way
          // past. A case that threw is not a case that failed a check, and folding
          // the two together is how a suite reports 100% over the three cases that
          // still run. It IS a failed run for pass^k: a case that did not finish
          // did not pass, and leaving the run out would shrink k instead.
          console.error(`case ${kase.id} run ${i + 1} did not complete: ${String(err)}`)
          runs.set(kase.id, [...(runs.get(kase.id) ?? []), false])
        }
      }
    }
    const k = [...runs].map(([caseId, passed]) => passAtK({ caseId, passed }))
    // The survival row. It reads course.conversions, which is empty on this
    // branch and on any branch a reader checks out, so this prints 0/0 (n/a) and
    // that is the honest number rather than a missing row. A rate whose
    // denominator is zero is a rate nobody measured, and the card has said so
    // since lesson 6.1: the numerator drops when something breaks and the
    // denominator does not.
    const survival: ScorecardRow = { name: 'survival:booked_unchanged', tally: { passed: 0, failed: 0, notEvaluated: 0 } }
    for (const userId of evalUsers) {
      for (const score of (await survivalScores(sql, { userId })).values()) {
        if (score.basis === 'none') survival.tally.notEvaluated += 1
        else if (score.value > GOLDEN_UNCHANGED_FLOOR) survival.tally.passed += 1
        else survival.tally.failed += 1
      }
    }
    const card = withRows(
      scorecardOf(graded, cases.length * RUNS),
      [...gateRows(await gateMetrics(sql, { userId: evalUsers })), survival, ...passAtKRows(k)],
    )
    console.log(renderScorecard(card))
    for (const flaky of k.filter((r) => r.flaky)) {
      console.log(`  flaky: ${flaky.caseId} passed ${flaky.passes} of ${flaky.k} runs`)
    }
    // Rates over the whole run, each with the denominator that produced it. The
    // turn count comes from the conversations and the label count from the
    // table, so a label write that failed shows as a gap rather than as a better
    // number. `turns labelled` short of `turns` is a finding and not a rounding:
    // it names turns whose write did not happen, and `labelTurn`
    // (src/evals/trajectory.ts) logged each one with its id on the way past.
    if (SECTIONS.includes('trajectory')) {
      const labels = (await Promise.all(evalRuns.map((r) =>
        readTurnLabels(sql, { conversationId: r.conversationId, userId: r.userId })))).flat()
      // Distinct ids, defensively. `invokeInProcess` (src/evals/conversation.ts)
      // records a turn id once per TURN, deduped as it pushes
      // (`if (!seen.includes(turnId))`), so a turn handed back for a later
      // invocation does not push a second id. The label table holds one row per
      // turn, and `new Set` keeps the denominator right even if that dedup
      // ever slipped.
      const turns = evalRuns.reduce((n, r) => n + new Set(r.turnIds).size, 0)
      const quoted = labels.reduce((n, l) => n + l.pricesQuoted, 0)
      const unbacked = labels.reduce((n, l) => n + l.unbackedPrices, 0)
      console.log(`  turns labelled       ${labels.length}/${turns}`)
      console.log(`  prices with a search ${quoted - unbacked}/${quoted}`)
    }
    // The judge, and the two lines that say whether anybody may act on it.
    //
    // It runs over the proposals SHE has already decided rather than over the
    // ones this run produced, because the number being computed is agreement
    // with her and a proposal nobody answered is not a label. The gates are
    // replayed first so the judge is shown the server's own rehydrated items
    // and never the model's prose about them, and through `replayGatesOnce`
    // rather than `replayGates`, so a cron that judges the same hundred
    // proposals every night writes one round-1 gate row set per proposal ever
    // rather than one per night.
    //
    // `liveClient` and not `replayClient`: there is one judge fixture and a
    // hundred proposals, so this section is the part of the card that costs
    // money. That is why `per-pr` turns it off and why the default run is
    // keyless.
    if (SECTIONS.includes('judge')) {
      // An eval conversation of its own, minted here, for the reason every
      // other eval conversation on this branch mints one (src/limits.ts): this
      // is what `runJudge` reserves and reconciles against, so billing it to
      // the conversation that produced the proposal would move HER spend for a
      // call she did not make and would apply EVAL_LIMITS' tighter ceilings to
      // her conversation. `judgeContext` (src/evals/judge.ts) is where that
      // rule is written down, and its turn id is null because the judge runs
      // outside any turn.
      const judgeUserId = randomUUID()
      const [jc] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${judgeUserId}) returning id`
      const ctx = judgeContext({ userId: judgeUserId, conversationId: jc!.id })
      const decided = await decidedProposals(sql, { limit: 100 })
      const client = liveClient()
      const labelled: Labelled[] = []
      for (const p of decided) {
        try {
          const replayed = await replayGatesOnce(sql, {
            proposalId: p.id, conversationId: p.conversationId, userId: p.userId,
            now: evalNow(), today: EVAL_TODAY,
          })
          const verdict = await runJudge(
            { sql, client, ctx, limits: EVAL_LIMITS, now: Date.now },
            replayed.outcome,
          )
          // A verdict that could not be read is not a disagreement. It is dropped
          // from the numerator AND from the agreement's denominator, so the rate
          // never improves because a reply was unparseable, and the line below
          // prints the decided count beside it so the drop is visible rather
          // than absorbed. A refused outcome lands here too: `runJudge` returns
          // null for a proposal the gates would reject today, which is a
          // proposal the rubric's first paragraph says it has no question about.
          if (verdict) labelled.push({ proposalId: p.id, decision: p.decision!, verdict: verdict.verdict })
        } catch (err) {
          // A reached ceiling ends the pass. It is the one error here that says
          // nothing about this proposal and everything about the run, and
          // carrying on would reserve, refuse and refund once for every
          // proposal left in the list.
          if (err instanceof JudgeCappedError) {
            console.error(`${err.message} ${labelled.length} of ${decided.length} proposals were judged.`)
            break
          }
          // Named on the way past and counted out of the numerator only, the
          // same shape the case loop above uses. A proposal written before
          // migration 0018 carries no requirements snapshot and `replayGates`
          // refuses it rather than replaying against the live notebook, and one
          // such row must not take down a card computed over ninety-nine
          // others.
          console.error(`proposal ${p.id} could not be judged: ${String(err)}`)
        }
      }
      const agreement = judgeAgreement(labelled)
      console.log(`  judge agreement      ${agreement.agreed}/${agreement.total}`
        + ` of ${decided.length} decided proposals`)
      console.log(`  deployable           ${agreement.meetsFloor ? 'yes' : `no, floor is ${AGREEMENT_FLOOR}`}`)
    }
    // The release canary's verdict, and the honest thing about it is the numbers.
    // Three golden cases, one prompt version, nobody in the candidate arm and no
    // conversions, so this prints one line that says n=3 and answers nothing. A
    // release canary needs enough conversations that a difference in conversion
    // is larger than the noise in conversion, and three is not a sample, it is an
    // anecdote with a denominator.
    for (const userId of evalUsers) {
      for (const row of await conversionByPromptVersion(sql, { userId })) {
        console.log(`  conversion ${row.promptVersion}  ${row.conversions}/${row.proposals} proposals`)
      }
    }
    console.log(`  release arm          ${RELEASE.rolloutPercent}% candidate, rollback is a commit`)
    await deleteRunRows(sql, evalUsers)
  } finally {
    await sql.end({ timeout: 5 })
  }

  const checks = graded.flatMap((g) => g.grades.flatMap((grade) =>
    grade.checks.map((check) => ({ caseId: g.caseId, check }))))
  for (const { caseId, check } of checks) {
    if (check.passed === false) console.log(`  FAIL  ${caseId}  ${check.name}: ${check.detail}`)
  }
  for (const { caseId, check } of checks) {
    if (check.passed === null) console.log(`  ${caseId}  ${check.name}: ${check.detail}`)
  }
  // Red on a verdict and never on a null. A proof command that cannot go red is
  // the shape of problem this module opens on, and one that went red because
  // four properties have not been built yet would train the reader to ignore it.
  const failed = checks.filter(({ check }) => check.passed === false).length
  if (failed > 0) process.exitCode = 1
}

await main()
