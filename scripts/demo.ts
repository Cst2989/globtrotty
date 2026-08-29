/**
 * A narrated tour of the harness, run against the real database.
 *
 * There is no model and no supplier yet — this exercises the durable-execution
 * layer that everything else will sit on. Each scenario prints what it is about
 * to do, does it, and prints the rows that resulted, so the guarantees are
 * visible rather than merely asserted.
 *
 *   npm run demo
 *
 * Safe to re-run: everything is scoped to one fixed demo user id and deleted at
 * both ends of the run.
 */
import { config } from 'dotenv'
import postgres from 'postgres'

config({ path: '.env.local', quiet: true })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — expected it in .env.local')
  process.exit(1)
}

import { submitMessage } from '../src/handler.js'
import { runTurn, type Agent } from '../src/worker.js'
import { sweep } from '../src/sweeper.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { claimTurn, saveTurnState, FencedError } from '../src/repo/turns.js'
import { beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'
import type { TurnState } from '../src/engine.js'

const DEMO_USER = '00000000-0000-4000-8000-00000000dec0'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
}

let scenario = 0
const head = (title: string, claim: string) => {
  console.log(`\n${c.bold(`── ${++scenario}. ${title} `.padEnd(72, '─'))}`)
  console.log(`${c.dim('   claim:')} ${claim}\n`)
}
const step = (s: string) => console.log(`   ${c.cyan('→')} ${s}`)
const ok = (s: string) => console.log(`   ${c.green('✓')} ${s}`)
const note = (s: string) => console.log(`   ${c.dim(s)}`)

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} })

/** Counts real executions, so "replayed" can be distinguished from "ran again". */
let sideEffects = 0

/**
 * Two steps: one tool call, then a message. The call id is derived from
 * `state.step` rather than generated fresh, which is what makes a resumed turn
 * recognise the call it already made. A random id would defeat the tool_calls
 * ledger entirely.
 */
const demoAgent: Agent = async ({ state }) => {
  if (state.step === 0) {
    return {
      kind: 'tool',
      callId: `search-${state.step}`,
      name: 'search_flights',
      costMicros: 2_000n,
      run: async () => {
        sideEffects++
        step(`tool search_flights EXECUTED (execution #${sideEffects})`)
        return { offers: [{ id: 'KIWI-1', price: 18400, currency: 'EUR' }] }
      },
    }
  }
  const found = state.messages.filter((m) => m.role === 'tool').length
  return {
    kind: 'message',
    text: `Found ${found} result set. Cheapest is €184.`,
    costMicros: 3_000n,
  }
}

const noopInvoke = async () => {}

async function turnRow(id: string) {
  const [r] = await sql`
    select status, attempts, fail_reason, spend_usd_micros,
           (state->>'step')::int as step
      from turns where id = ${id}`
  return r as { status: string; attempts: number; fail_reason: string | null; spend_usd_micros: string; step: number | null }
}

async function convRow(id: string) {
  const [r] = await sql`select status, spend_usd_micros from conversations where id = ${id}`
  return r as { status: string; spend_usd_micros: string }
}

async function cleanup() {
  await sql`delete from conversations where user_id = ${DEMO_USER}`
  await sql`delete from daily_usage where user_id = ${DEMO_USER}`
}

async function main() {
  console.log(c.bold('\nGlobetrotty — harness tour'))
  note(`database: ${new URL(process.env.DATABASE_URL!).host}`)
  note(`demo user: ${DEMO_USER}`)
  await cleanup()

  // ─────────────────────────────────────────────────────────────────────────
  head('A message becomes durable work',
       'the turn is committed before anything is scheduled, so a crash here loses nothing')

  const first = await submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: noopInvoke },
    { userId: DEMO_USER, conversationId: null, message: 'Cheap week in Faro in September?', idempotencyKey: 'k1' },
  )
  const convId = first.conversationId
  const turnId = first.turnId!
  ok(`status=${first.status}  turn=${turnId.slice(0, 8)}  conversation=${convId.slice(0, 8)}`)
  ok(`turn row: ${JSON.stringify(await turnRow(turnId))}`)
  note('note: invoke() is a no-op here — the row exists regardless. That is the point.')

  // ─────────────────────────────────────────────────────────────────────────
  head('The same request twice',
       'a retried POST must not buy a second turn')

  const dupe = await submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: noopInvoke },
    { userId: DEMO_USER, conversationId: convId, message: 'Cheap week in Faro in September?', idempotencyKey: 'k1' },
  )
  ok(`status=${dupe.status}  turn=${dupe.turnId?.slice(0, 8)}  ${dupe.turnId === turnId ? '(same turn)' : c.red('(DIFFERENT TURN — bug)')}`)

  // ─────────────────────────────────────────────────────────────────────────
  head('Impatient typing while the agent is working',
       'a second turn cannot open, but the words are never dropped')

  const busy = await submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: noopInvoke },
    { userId: DEMO_USER, conversationId: convId, message: 'actually make it October', idempotencyKey: 'k2' },
  )
  const [{ count: stored }] = await sql`
    select count(*)::int as count from messages where conversation_id = ${convId} and role = 'user'`
  ok(`status=${busy.status}  (no new turn)`)
  ok(`user messages stored: ${stored}  — the second message is kept for the running turn to read`)

  // ─────────────────────────────────────────────────────────────────────────
  head('Power loss mid-turn',
       'the tool ran once; the resumed turn must not run it again')

  step('worker claims the turn and runs the tool...')
  const claim = (await claimTurn(sql, turnId))!
  const outcome = await beginToolCall(sql, turnId, 'search-0', 'search_flights')
  if (outcome.status === 'fresh') {
    sideEffects++
    step(`tool search_flights EXECUTED (execution #${sideEffects})`)
    await finishToolCall(sql, turnId, 'search-0', { offers: [{ id: 'KIWI-1', price: 18400, currency: 'EUR' }] })
  }
  const partial: TurnState = {
    step: 1,
    messages: [{ role: 'user', content: 'Cheap week in Faro in September?' },
               { role: 'tool', content: '{"offers":[{"id":"KIWI-1"}]}' }],
    reviewRounds: 0,
  }
  await saveTurnState(sql, claim, partial)
  console.log(`   ${c.yellow('✱')} ${c.yellow('the process dies here — no completeTurn, no failTurn')}`)
  ok(`turn row: ${JSON.stringify(await turnRow(turnId))}`)

  step('90 seconds of silence pass (simulated by backdating heartbeat_at)...')
  await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${turnId}`

  step('the sweeper runs (this is the scheduled function)...')
  const swept = await sweep(sql)
  ok(`requeued=${swept.requeued.length}  reaped=${swept.reaped.length}  backlog=${swept.backlog}`)

  step('a fresh worker picks it up...')
  await runTurn(
    { sql, limits: DEFAULT_LIMITS, agent: demoAgent, now: () => Date.now(),
      deadlineMs: () => Date.now() + 600_000, reinvoke: noopInvoke },
    turnId,
  )
  ok(`turn row: ${JSON.stringify(await turnRow(turnId))}`)
  ok(`conversation: ${JSON.stringify(await convRow(convId))}`)
  const [agentMsg] = await sql`
    select content from messages where turn_id = ${turnId} and role = 'agent'`
  ok(`agent said: "${(agentMsg as { content: string } | undefined)?.content}"`)

  if (sideEffects === 1) {
    console.log(`   ${c.green('✓')} ${c.bold(c.green(`side effects: ${sideEffects} — the tool ran ONCE across a crash and a resume`))}`)
  } else {
    console.log(`   ${c.red('✗')} ${c.red(`side effects: ${sideEffects} — the tool ran more than once`)}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  head('Two workers, one turn',
       'the loser must not be able to write, even though it thinks it owns the turn')

  const second = await submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: noopInvoke },
    { userId: DEMO_USER, conversationId: convId, message: 'and a hotel?', idempotencyKey: 'k3' },
  )
  const t2 = second.turnId!
  const workerA = (await claimTurn(sql, t2))!
  step(`worker A claims — attempts=${workerA.attempts}`)
  await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t2}`
  const workerB = (await claimTurn(sql, t2))!
  step(`worker B takes over the stale turn — attempts=${workerB.attempts}`)

  step('worker A, still alive and unaware, tries to save its state...')
  try {
    await saveTurnState(sql, workerA, { step: 99, messages: [], reviewRounds: 0 })
    console.log(`   ${c.red('✗')} ${c.red('worker A wrote — the fencing token failed')}`)
  } catch (e) {
    if (e instanceof FencedError) ok(`rejected: ${e.name} — worker A is superseded and writes nothing`)
    else throw e
  }
  const after = await turnRow(t2)
  ok(`state.step is ${after.step ?? 'null'}, not 99 — worker A's write never landed`)

  // ─────────────────────────────────────────────────────────────────────────
  head('The spend ledger',
       'every model call is metered before the next one is allowed')

  const conv = await convRow(convId)
  const [day] = await sql`
    select cost_micros from daily_usage
     where user_id = ${DEMO_USER} and day = (now() at time zone 'utc')::date`
  const [all] = await sql`
    select coalesce(sum(cost_micros), 0)::text as total from daily_usage
     where day = (now() at time zone 'utc')::date`
  const usd = (micros: string) => `$${(Number(micros) / 1_000_000).toFixed(6)}`
  ok(`conversation spend: ${usd(conv.spend_usd_micros)}  (ceiling ${usd(DEFAULT_LIMITS.conversationCeilingMicros.toString())})`)
  ok(`today's spend:      ${usd((day as { cost_micros: string }).cost_micros)}  (ceiling ${usd(DEFAULT_LIMITS.dailyCeilingMicros.toString())})`)
  ok(`every user today:   ${usd((all as { total: string }).total)}  (ceiling ${usd(DEFAULT_LIMITS.globalCeilingMicros.toString())})`)
  note('all three are checked before every model call — the last one caps the whole')
  note('account, so it can refuse a user who has personally spent nothing.')
  // Stated precisely, because the demo is what people read instead of the code:
  // only the CONVERSATION read fails closed. A missing daily row and a sum over
  // zero rows are both legitimately zero, so neither can distinguish "nothing
  // spent" from "no answer" — see readSpendFailClosed's doc comment.
  note('the conversation read fails closed: if the database cannot confirm that')
  note('number the request is denied, and the daily and global reads ride on it.')

  console.log(`\n${c.bold('── done ')}${'─'.repeat(64)}`)
  note('cleaning up demo rows...')
  await cleanup()
  console.log()
}

main()
  .catch((e) => { console.error(c.red('\ndemo failed:'), e); process.exitCode = 1 })
  .finally(() => sql.end({ timeout: 5 }))
