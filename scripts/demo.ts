/**
 * A narrated tour of the harness, against the real database.
 *
 * There is no model here and no supplier. Every claim it prints is about the
 * layer underneath both, which is exactly why it can run with no API key:
 *
 *   npm run demo
 *
 * Everything this script CREATES is scoped to DEMO_SCRIPT_USER (src/her.ts),
 * its own id, distinct from `npm run trip`'s DEMO_USER: the two scripts share
 * a database and trip is the one script that spends real dollars on a live
 * model, so a shared id would let this script's cleanup() delete a
 * conversation trip just paid for. The one thing that is NOT scoped is the
 * sweeper, which is global by design and genuinely destructive on a shared
 * database: it requeues or fails every OTHER user's stale turn too, not only
 * this script's own. Point this at a scratch database rather than a shared
 * one if that matters to you.
 */
import 'dotenv/config'
import { config } from 'dotenv'
import { connect } from '../src/db.js'
import type { TurnState } from '../src/engine.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_SCRIPT_USER } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'
import { claimTurn, saveTurnState, FencedError } from '../src/repo/turns.js'
import { sweep } from '../src/sweeper.js'
import { runTurn, type Agent } from '../src/worker.js'

config({ path: '.env.local', override: false })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

const sql = connect(process.env.DATABASE_URL, 4)
const noop = async () => {}
const deps = { sql, limits: DEFAULT_LIMITS, invoke: noop }

let scenario = 0
const head = (title: string, claim: string) => {
  console.log(`\n== ${++scenario}. ${title} ${'='.repeat(Math.max(0, 64 - title.length))}`)
  console.log(`   claim: ${claim}\n`)
}
const step = (s: string) => console.log(`   -> ${s}`)
const ok = (s: string) => console.log(`   ok  ${s}`)
const note = (s: string) => console.log(`       ${s}`)

/** Counts real executions, so "replayed" can be told apart from "ran again". */
let sideEffects = 0

/**
 * Two steps: one tool call, then a message. The call id comes from `state.step`
 * rather than being generated fresh, which is what lets a resumed turn recognise
 * the call it already made. A random id would defeat the ledger entirely.
 */
const demoAgent: Agent = async ({ state }) => {
  if (state.step === 0) {
    return {
      kind: 'tool', callId: `search-${state.step}`, name: 'search_flights', costMicros: 2_000n,
      run: async () => {
        sideEffects += 1
        step(`tool search_flights EXECUTED (execution number ${sideEffects})`)
        return { offers: [{ id: 'MOCK-1', minor: '18400', currency: 'EUR' }] }
      },
    }
  }
  const found = state.messages.filter((m) => m.role === 'tool').length
  return { kind: 'message', text: `Found ${found} result set. The cheapest is 184 EUR.`, costMicros: 3_000n }
}

async function turnRow(id: string) {
  const [r] = await sql`
    select status, attempts, fail_reason, spend_usd_micros, (state->>'step')::int as step
      from course.turns where id = ${id}`
  return r
}

async function cleanup() {
  await sql`delete from course.model_calls where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.messages where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.turns where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.conversations where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.daily_usage where user_id = ${DEMO_SCRIPT_USER}`
}

async function main() {
  console.log('\nGlobetrotty, a tour of the harness')
  note(`database: ${new URL(process.env.DATABASE_URL!).host}`)
  await cleanup()

  head('A message becomes durable work',
       'the turn is committed before anything is scheduled, so a crash here loses nothing')
  const first = await submitMessage(deps, {
    userId: DEMO_SCRIPT_USER, conversationId: null, message: 'A cheap week in Faro in September?',
    idempotencyKey: 'demo-1',
  })
  const conversationId = first.conversationId
  const turnId = first.turnId!
  ok(`status ${first.status}, turn ${turnId.slice(0, 8)}, conversation ${conversationId.slice(0, 8)}`)
  ok(`turn row: ${JSON.stringify(await turnRow(turnId))}`)
  note('invoke() is a no-op here, and the row exists anyway. That is the whole point.')

  head('The same press again', 'a retried POST must not buy a second turn')
  const dupe = await submitMessage(deps, {
    userId: DEMO_SCRIPT_USER, conversationId, message: 'A cheap week in Faro in September?',
    idempotencyKey: 'demo-1',
  })
  ok(`status ${dupe.status}, turn ${dupe.turnId?.slice(0, 8)}` +
     `${dupe.turnId === turnId ? ' (the same turn)' : ' (A DIFFERENT TURN, which is a bug)'}`)

  head('Power loss mid-turn', 'the tool ran once; the resumed turn must not run it again')
  step('a worker claims the turn and runs the tool...')
  const claim = (await claimTurn(sql, turnId))!
  const outcome = await beginToolCall(sql, claim, 'search-0', 'search_flights')
  if (outcome.status === 'fresh') {
    sideEffects += 1
    step(`tool search_flights EXECUTED (execution number ${sideEffects})`)
    await finishToolCall(sql, claim, 'search-0', { offers: [{ id: 'MOCK-1' }] })
  }
  // The state is saved WITHOUT the search result, because that is the window
  // the ledger exists for: the call has landed at the supplier and in
  // course.tool_calls, and the process dies before the state that carries its
  // answer is written. Save `step: 1` with the tool line already in the
  // transcript and the resumed agent below simply never asks for the tool
  // again, so the count stays at 1 whether the ledger works or not and this
  // scenario proves nothing.
  const partial: TurnState = {
    step: 0,
    messages: [{ role: 'user', content: 'A cheap week in Faro in September?' }],
  }
  await saveTurnState(sql, claim, partial)
  console.log('   !!  the process dies here: no completeTurn, no failTurn')
  note('the ledger has the call. The saved state does not, so the resumed turn')
  note('will ask for the same search again and the ledger has to refuse it.')
  ok(`turn row: ${JSON.stringify(await turnRow(turnId))}`)

  step('ninety seconds of silence pass (simulated by backdating heartbeat_at)...')
  await sql`update course.turns set heartbeat_at = now() - interval '5 minutes' where id = ${turnId}`
  step('the sweeper runs, which on Netlify is the scheduled function...')
  note('sweep() is deliberately global: it is the floor walk, not a per-user query.')
  note('On a shared database this is destructive to OTHER people\'s work: it')
  note('requeues or fails their stale turns too, the same as it does here.')
  const swept = await sweep(sql)
  ok(`requeued ${swept.requeued.length}, reaped ${swept.reaped.length}, stalled ${swept.stalled.length}, backlog ${swept.backlog}`)

  step('a fresh worker picks it up, asks for search-0 again, and is replayed...')
  await runTurn(
    { sql, limits: DEFAULT_LIMITS, agent: demoAgent, now: Date.now,
      deadlineMs: () => Date.now() + 600_000, reinvoke: noop },
    turnId,
  )
  ok(`turn row: ${JSON.stringify(await turnRow(turnId))}`)
  const [said] = await sql`select content from course.messages where turn_id = ${turnId} and role = 'agent'`
  ok(`the agency said: "${(said as { content: string } | undefined)?.content}"`)
  console.log(sideEffects === 1
    ? `   ok  side effects: ${sideEffects}. The tool ran ONCE across a crash and a resume.`
    : `   XX  side effects: ${sideEffects}. The tool ran more than once.`)

  head('Two workers, one turn', 'the loser must not be able to write, though it believes it owns the turn')
  const second = await submitMessage(deps, {
    userId: DEMO_SCRIPT_USER, conversationId, message: 'And a hotel?', idempotencyKey: 'demo-2',
  })
  const t2 = second.turnId!
  const workerA = (await claimTurn(sql, t2))!
  step(`worker A claims, attempts ${workerA.attempts}`)
  await sql`update course.turns set heartbeat_at = now() - interval '5 minutes' where id = ${t2}`
  const workerB = (await claimTurn(sql, t2))!
  step(`worker B takes over the silent turn, attempts ${workerB.attempts}`)
  step('worker A, still alive and unaware, tries to save its state...')
  try {
    await saveTurnState(sql, workerA, { step: 99, messages: [] })
    console.log('   XX  worker A wrote. The fencing token failed.')
  } catch (e) {
    if (!(e instanceof FencedError)) throw e
    ok(`refused: ${e.name}. Worker A is superseded and writes nothing.`)
  }
  ok(`state.step is ${(await turnRow(t2))?.step ?? 'null'}, not 99`)

  head('The spend ledger', 'every step is metered before the next one is allowed')
  const [conv] = await sql`select spend_usd_micros from course.conversations where id = ${conversationId}`
  const [day] = await sql`select cost_micros from course.daily_usage
                           where user_id = ${DEMO_SCRIPT_USER} and day = (now() at time zone 'utc')::date`
  const usd = (micros: string) => `$${(Number(micros) / 1_000_000).toFixed(6)}`
  ok(`conversation spend ${usd(conv!.spend_usd_micros as string)} (ceiling ${usd(DEFAULT_LIMITS.conversationCeilingMicros.toString())})`)
  ok(`today's spend      ${usd((day?.cost_micros as string) ?? '0')} (ceiling ${usd(DEFAULT_LIMITS.dailyCeilingMicros.toString())})`)
  note('all three ceilings are read before every step. Only the conversation read')
  note('fails closed: a missing daily row and a sum over no rows are both honestly')
  note('zero, so neither can tell "nothing spent" from "no answer".')

  console.log(`\n== done ${'='.repeat(64)}`)
  note('cleaning up the demo rows...')
  await cleanup()
  console.log()
}

main()
  .catch((e) => { console.error('\ndemo failed:', e); process.exitCode = 1 })
  .finally(() => sql.end({ timeout: 5 }))
