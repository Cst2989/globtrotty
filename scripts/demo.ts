/**
 * A narrated tour of the harness, against the real database.
 *
 * There is no model here and no live supplier: the last scenario runs the gates
 * and the cashier against the mock, which needs no key either. Every claim it
 * prints is about the layer underneath the model, which is exactly why it can
 * run with no API key:
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
import { cashierRunner } from '../src/cashier.js'
import { acceptCard, cardForProposal } from '../src/channel.js'
import { connect } from '../src/db.js'
import type { TurnState } from '../src/engine.js'
import { TODAY } from '../src/conversation.js'
import { constraintsFromNotebook } from '../src/gates/pipeline.js'
import { proposalRunner } from '../src/gates/runner.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_SCRIPT_USER } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { money } from '../src/money.js'
import { applyRequirementsPatch, loadNotebook } from '../src/repo/notebook.js'
import { beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'
import { claimTurn, saveTurnState, FencedError } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import { sweep } from '../src/sweeper.js'
import { corpusRunner, ledgerRunner, supplierRunner } from '../src/tools.js'
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
 * What the search "returns", as a `ToolOutcome`: the shape every runner in the
 * chain hands back, and the shape a replayed row has to come back as for
 * `ledgerRunner` to give it to the model (`isToolOutcome`, src/tools.ts).
 */
const SEARCH_RESULT = { id: 'MOCK-1', minor: '18400', currency: 'EUR' }

/**
 * Two steps: one tool call, then a message. The call id comes from `state.step`
 * rather than being generated fresh, which is what lets a resumed turn recognise
 * the call it already made. A random id would defeat the ledger entirely.
 *
 * The ledger is the layer that recognises it, and it is a layer of the runner
 * chain rather than anything the harness does: this agent wraps its own runner
 * in `ledgerRunner` exactly the way tier 3 does
 * (netlify/functions/run-turn-background.mts). The harness writes no
 * `course.tool_calls` row of its own, so a tool that is not run through the
 * ledger is a tool that runs again after a crash.
 */
const demoAgent: Agent = async (ctx) => {
  const { state } = ctx
  if (state.step === 0) {
    const callId = `search-${state.step}`
    const run = ledgerRunner(
      sql,
      { turnId: ctx.turnId, conversationId: ctx.conversationId, userId: ctx.userId,
        attempts: ctx.attempts, state: ctx.state },
      async () => {
        sideEffects += 1
        step(`tool search_flights EXECUTED (execution number ${sideEffects})`)
        return { content: JSON.stringify({ offers: [SEARCH_RESULT] }), isError: false }
      },
    )
    return {
      kind: 'tool', callId, name: 'search_flights', costMicros: 2_000n,
      // A demo agent says nothing before it calls: there is no assistant turn to
      // echo, and an empty array is the honest answer rather than a fabricated
      // one (src/worker.ts's AgentStep).
      assistantContent: [],
      run: (signal) => run('search_flights', {}, callId, signal),
    }
  }
  // From lesson 5.1 a tool result is a `tool_result` BLOCK inside a user
  // message, not a line under a 'tool' role, so the count is over blocks.
  const found = state.messages
    .filter((m) => m.content.some((b) => b.type === 'tool_result')).length
  return { kind: 'message', text: `Found ${found} result set. The cheapest is 184 EUR.`, costMicros: 3_000n }
}

async function turnRow(id: string) {
  const [r] = await sql`
    select status, attempts, fail_reason, spend_usd_micros, (state->>'step')::int as step
      from course.turns where id = ${id}`
  return r
}

async function cleanup() {
  await sql`delete from course.link_clicks where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.proposals where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.gate_results where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.tool_results where user_id = ${DEMO_SCRIPT_USER}`
  await sql`delete from course.model_calls where user_id = ${DEMO_SCRIPT_USER}`
  // Above the turns delete, because agent_events.turn_id is `on delete set
  // null` and a feed row would outlive the turn it describes.
  await sql`delete from course.agent_events where user_id = ${DEMO_SCRIPT_USER}`
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
    await finishToolCall(sql, claim, 'search-0',
      { content: JSON.stringify({ offers: [SEARCH_RESULT] }), isError: false })
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
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A cheap week in Faro in September?' }] }],
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

  head('References in, a link out',
       'the model sends no price and no URL, and the link_clicks row exists before she is given the link')
  const suppliers = mockSuppliers()
  // Its own conversation, and a turn a worker has actually CLAIMED. The corpus
  // write is fenced on that claim (src/repo/toolResults.ts, lesson 4.3), so a
  // search run outside one records nothing at all and the gates would have
  // nothing to rehydrate. A fresh thread rather than a third press on the first
  // one, because scenario 4 deliberately left that conversation holding a live
  // turn.
  const booking = await submitMessage(deps, {
    userId: DEMO_SCRIPT_USER, conversationId: null,
    message: 'Book the Faro trip.', idempotencyKey: 'demo-3',
  })
  const bookingClaim = (await claimTurn(sql, booking.turnId!))!
  const ctx = {
    conversationId: booking.conversationId, userId: DEMO_SCRIPT_USER, turnId: bookingClaim.turnId,
  }
  // Her notebook, written to course.conversations.requirements (migration 0015,
  // lesson 5.2) before the gates are asked anything. In a real turn this row is
  // written by `update_requirements` through `notebookRunner`; here the script
  // states it directly, because this scenario is about what the gates can judge
  // rather than about how the notebook got filled.
  await applyRequirementsPatch(sql, {
    conversationId: booking.conversationId, userId: DEMO_SCRIPT_USER,
    source: 'user', at: new Date().toISOString(),
    patch: { budget: money(1_000_000n, 'EUR'), month: 'September', nights: 7 },
  })
  // Named rather than inlined, because `proposalRunner` now takes BOTH the raw
  // notebook and the three fields the gates read off it (lesson 6.2): the
  // snapshot is what course.proposals stores, and re-reading it later would be
  // reading the live notebook again.
  const hersNotebook = await loadNotebook(sql, booking.conversationId, DEMO_SCRIPT_USER)
  const hers = constraintsFromNotebook(hersNotebook, TODAY)
  // The chain tier 3 builds (netlify/functions/run-turn-background.mts), minus
  // ledgerRunner: the ledger is scenario 3's subject rather than this one's.
  const run = cashierRunner(
    sql, ctx,
    { suppliers, limits: DEFAULT_LIMITS, now: () => new Date() },
    proposalRunner(
      sql,
      { ...ctx, notebook: hers, snapshot: hersNotebook, now: () => new Date() },
      corpusRunner(sql, bookingClaim, supplierRunner(suppliers, hers.currency)),
    ),
  )

  step('the model searches, and every result lands in course.tool_results...')
  const searched = await run('search_flights', {
    from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
    adults: 2, children: 0,
  }, 'demo-search')
  const offers = JSON.parse(searched.content) as { sourceId: string }[]
  ok(`${offers.length} offers recorded: ${offers.map((o) => o.sourceId).join(', ')}`)

  step('it proposes two of them BY REFERENCE. There is no price field to tamper with...')
  const proposed = await run('propose_itinerary', {
    refs: [
      { sourceId: offers[0]!.sourceId, quantity: 1, slot: 'outbound' },
      { sourceId: offers[1]!.sourceId, quantity: 1, slot: 'inbound' },
    ],
  }, 'demo-propose')
  const proposal = JSON.parse(proposed.content) as
    { ok: boolean; proposalId: string; total: { minor: string; currency: string } }
  ok(`gates passed. The SERVER's total is ${proposal.total.minor} ${proposal.total.currency}, `
   + `read back out of the corpus; proposal ${proposal.proposalId.slice(0, 8)}`)
  const gates = await sql<{ gate: string; passed: boolean | null }[]>`
    select gate, passed from course.gate_results
     where conversation_id = ${booking.conversationId} order by gate`
  ok(`course.gate_results: ${gates.map((g) => `${g.gate}=${g.passed ?? 'not evaluated'}`).join(' ')}`)
  note('budget and dates reach a verdict from lesson 5.2, because the notebook has')
  note('a column and a reader. Until then both read "not evaluated": this script and')
  note('tier 3 derived their constraints from an empty notebook, and a gate that')
  note('never fired must not count as a pass.')

  step('the server renders the card she is shown. Every price on it was read')
  step('back out of course.tool_results; none of it came off the model...')
  const card = await cardForProposal(sql, {
    proposalId: proposal.proposalId, conversationId: booking.conversationId,
    currency: hers.currency,
  })
  for (const c of card!.components) note(`${c.slot.padEnd(9)} ${c.price.padStart(9)}   [change]`)
  note(`${'total'.padEnd(9)} ${card!.total.padStart(9)}`)
  note(card!.footer)

  step('she presses accept. That click is one server-side function, acceptCard,')
  step('and it is the only production caller decideProposal has (lesson 5.7)...')
  const handOff = await acceptCard(sql, {
    proposalId: proposal.proposalId, conversationId: booking.conversationId,
    userId: DEMO_SCRIPT_USER, turnId: bookingClaim.turnId,
    suppliers, limits: DEFAULT_LIMITS, now: new Date(),
  })
  if (!handOff.ok) throw new Error(`the cashier refused: ${handOff.refusal.kind}`)
  const [decided] = await sql<{ decision: string }[]>`
    select decision from course.proposals where id = ${proposal.proposalId}`
  ok(`course.proposals.decision is '${decided!.decision}', written in production for the `
   + 'first time since lesson 4.6')
  ok(`verified ${handOff.verified}, ${handOff.links.length} links, every one on an allowlisted host`)
  for (const l of handOff.links) note(l.url)
  const clicks = await sql<{ url: string }[]>`
    select url from course.link_clicks where proposal_id = ${proposal.proposalId} order by seq`
  console.log(clicks.length === handOff.links.length
      && clicks.every((c, i) => c.url === handOff.links[i]!.url)
    ? `   ok  course.link_clicks holds the ${clicks.length} exact URLs she was given, `
      + 'written BEFORE she was given them.'
    : '   XX  a stored URL differs from the one emitted.')

  step('and the model asks for the hand-off anyway, through the runner chain...')
  // The tool path, restored: `hand_off_to_booking` through `cashierRunner`, which
  // is how a model reaches the cashier and is the only exercise of that wrapper
  // this script has. It is asked AFTER the accept rather than instead of it,
  // because that is the order the product now runs in, and the answer is rule 6
  // in one line: a proposal whose links have been emitted is refused before a
  // supplier is asked anything, so one trip cannot produce two sets of links.
  const again = await run('hand_off_to_booking', { proposalId: proposal.proposalId }, 'demo-handoff')
  const refusal = JSON.parse(again.content) as { refusal: { kind: string } }
  console.log(again.isError && refusal.refusal.kind === 'already_emitted'
    ? `   ok  refused: ${refusal.refusal.kind}. The links exist and are hers already; `
      + 'nothing was re-quoted.'
    : `   XX  the cashier answered ${again.content} to a second hand-off.`)

  note('that write is the point of no return: after it nothing may mark the turn')
  note('failed, which is what src/worker.ts and src/sweeper.ts now both check for.')

  console.log(`\n== done ${'='.repeat(64)}`)
  note('cleaning up the demo rows...')
  await cleanup()
  console.log()
}

main()
  .catch((e) => { console.error('\ndemo failed:', e); process.exitCode = 1 })
  .finally(() => sql.end({ timeout: 5 }))
