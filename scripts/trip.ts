import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import { config } from 'dotenv'
import { makeDriver, provenanceFor } from '../src/agents/driver.js'
import { cashierRunner } from '../src/cashier.js'
import { acceptCard, cardForProposal } from '../src/channel.js'
import { liveClient } from '../src/client.js'
import { TODAY } from '../src/conversation.js'
import { connect } from '../src/db.js'
import { loadEnv } from '../src/env.js'
import { constraintsFromNotebook } from '../src/gates/pipeline.js'
import { proposalRunner } from '../src/gates/runner.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_USER, HER_MESSAGE } from '../src/her.js'
import { httpInvoke } from '../src/invoke.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { dollars } from '../src/pricing.js'
import { loadNotebook, renderNotebook } from '../src/repo/notebook.js'
import { estimateMicros } from '../src/repo/reservation.js'
import { SEATS } from '../src/seats.js'
import { liveSuppliers } from '../src/supplier/live.js'
import {
  cardRunner, corpusRunner, doorRunner, escalationRunner, notebookRunner, scoutRunner,
  scoutStayFrom, supplierRunner, type ToolRunner,
} from '../src/tools.js'
import { runTurn, type Agent, type AgentContext } from '../src/worker.js'

config({ path: '.env.local', override: false })
const env = loadEnv(process.env)

const sql = connect(env.DATABASE_URL)
const text = process.argv[2] ?? HER_MESSAGE
try {
  // The conversation row is created here rather than by submitMessage, because
  // the in-process invoke below needs its id: the Conversation the loop works on
  // and the conversation the database holds have to be the same one, or the
  // reply is written against a row nobody will read. Lesson 2.2's other path,
  // TIER3, does not need this: the background function loads the id from the
  // turn itself.
  const [row] = await sql`insert into course.conversations (user_id) values (${DEMO_USER}) returning id`
  const conversationId = row!.id as string

  // `npm run trip` runs the turn here, in this process, which is what lesson 2.1
  // showed. `TIER3=1 npm run trip`, with `npx netlify dev` running in another
  // terminal, posts to the background function instead and returns immediately:
  // the same submitMessage, a different tier doing the work.
  const { suppliers, hotelSource } = liveSuppliers()
  console.log(`suppliers: flights from kiwi (no key needed), hotels from ${hotelSource}`)
  const client = liveClient()

  const inProcess = async (turnId: string) => {
    console.log(`turn ${turnId} is durable; running it now. Press ctrl-c to kill it.`)

    /**
     * The same chain tier 3 composes (netlify/functions/run-turn-background.mts),
     * minus the ledger: one process, no crash to resume from, and nothing here
     * replays a tool call.
     *
     * Nine wrappers here and ten on tier 3, and the one missing is the
     * ledger. The scout runner (lesson 5.4) sits directly inside the notebook
     * on both, which on tier 3 also puts it inside the ledger so a replayed
     * fan-out replays the briefs; here there is nothing to replay from. The card
     * and escalation runners (lesson 5.7) sit between the scout and the cashier
     * on both, in that order.
     *
     * `hand_off_to_booking` is the one tool in this chain the missing ledger
     * would matter for, and it is left out anyway. On tier 3 the ledger is what
     * makes a crash between minting the course.link_clicks rows and recording
     * the tool result end the turn `ambiguous_tool_call` instead of emitting a
     * second set of links; here there is no second attempt to protect, because
     * ctrl-c kills the only process there is. The cashier's own refusal covers
     * the rest: a proposal that already emitted is refused before it is
     * re-quoted, whichever chain asks.
     *
     * Built per agent step, like tier 3's, because the notebook is read fresh
     * every step and because `corpusRunner` fences its writes on a claim whose
     * `attempts` only the harness knows.
     */
    const runnerFor = async (ctx: AgentContext): Promise<ToolRunner> => {
      const claim = {
        turnId: ctx.turnId, conversationId: ctx.conversationId, userId: ctx.userId,
        attempts: ctx.attempts, state: ctx.state,
      }
      // The raw notebook is kept as well as the constraints: the gates want the
      // three fields `constraintsFromNotebook` keeps, and a scouting search
      // wants her nights and her party size, which it drops.
      const nb = await loadNotebook(sql, ctx.conversationId, ctx.userId)
      const notebook = constraintsFromNotebook(nb, TODAY)
      const gateCtx = { conversationId, userId: DEMO_USER, turnId }
      return doorRunner('planning', notebookRunner(
        sql,
        {
          conversationId, userId: DEMO_USER,
          // Derived from this step's transcript, the same way tier 3 derives it.
          // Until this lesson this script passed `() => 'inferred'`
          // unconditionally, because `turn()` kept its messages in a local array
          // inside the call and there was no transcript here to read. The driver
          // persists one, so the real rule applies on this path too.
          source: () => provenanceFor(ctx),
          now: () => new Date(),
        },
        scoutRunner(
          sql,
          {
            client, suppliers, stay: scoutStayFrom(nb, TODAY),
            conversationId, userId: DEMO_USER, turnId,
            limits: DEFAULT_LIMITS, now: Date.now,
          },
          cardRunner(
            sql, gateCtx,
            escalationRunner(
              sql, gateCtx,
              cashierRunner(
                sql, gateCtx,
                { suppliers, limits: DEFAULT_LIMITS, now: () => new Date() },
                proposalRunner(
                  sql,
                  { ...gateCtx, notebook, now: () => new Date() },
                  // The searches ask for the SAME currency the gates expect, off
                  // the same constraints object, so a corpus and the currency
                  // gate cannot disagree by construction.
                  corpusRunner(sql, claim, supplierRunner(suppliers, notebook.currency)),
                ),
              ),
            ),
          ),
        ),
      ))
    }

    /**
     * The driver, and `runTurn` around it: the same two pieces tier 3 runs, so
     * what a reader watches here is what the product does. Until lesson 5.3 this
     * script ran `turn()` in one process instead, which meant `ask_user` came
     * back to the model as an error result and the desk was always the planning
     * one.
     *
     * No `record:` sink and no `ledgerSink` any more. The driver reserves before
     * every call and reconciles after (src/agents/driver.ts), and writes its own
     * row through `pgSink`, so handing it a sink that also moves money would
     * charge the same micros twice.
     */
    const agent: Agent = async (ctx) => makeDriver({
      sql, client, run: await runnerFor(ctx), limits: DEFAULT_LIMITS, now: Date.now,
    })(ctx)

    await runTurn(
      {
        sql,
        limits: DEFAULT_LIMITS,
        agent,
        now: Date.now,
        // Ten minutes, and a hand-back that says so rather than re-invoking: a
        // script has nothing to re-invoke itself with, and a reader watching a
        // turn stop for want of wall clock should be told that is what happened.
        deadlineMs: () => Date.now() + 10 * 60_000,
        reinvoke: async (id) => console.log(`turn ${id} was handed back; run the script again`),
      },
      turnId,
    )

    const [reply] = await sql<{ content: string }[]>`
      select content from course.messages
       where turn_id = ${turnId} and role = 'agent' order by seq desc limit 1`
    console.log(reply?.content ?? '(no reply was written)')

    // The card, and the accept button behind it (lesson 5.7). The prose above
    // carries no amount at all, because `src/worker.ts` runs `redactCurrency`
    // over it before anything reaches course.messages; every price below was
    // read back out of course.tool_results by the gates. That pair is the
    // lesson, and printing them one after the other is the only way to see it.
    const [pending] = await sql<{ id: string }[]>`
      select id from course.proposals
       where conversation_id = ${conversationId} and decision is null
       order by seq desc limit 1`
    if (pending) {
      const card = await cardForProposal(sql, {
        proposalId: pending.id, conversationId, currency: null,
      })
      if (card) {
        console.log(`\n== the offer ${'='.repeat(52)}`)
        for (const c of card.components) {
          console.log(`  ${c.slot.padEnd(9)} ${c.name.padEnd(38)} ${c.price.padStart(9)}   [change]`)
        }
        console.log(`  ${'-'.repeat(64)}`)
        console.log(`  ${'total'.padEnd(48)} ${card.total.padStart(9)}`)
        console.log(`  ${card.footer}`)
        console.log('  [accept]')

        // The click. One function, `acceptCard`, and it is the only production
        // caller `decideProposal` has: the terminal here, the demo's sixth
        // scenario and whatever browser eventually exists all take this path.
        const accepted = await acceptCard(sql, {
          proposalId: pending.id, conversationId, userId: DEMO_USER, turnId,
          suppliers, limits: DEFAULT_LIMITS, now: new Date(),
        })
        if (accepted.ok) {
          console.log(`\n  accepted. verified ${accepted.verified}, `
            + `${accepted.links.length} booking link(s):`)
          for (const l of accepted.links) console.log(`    ${l.url}`)
        } else {
          console.log(`\n  the cashier refused: ${accepted.refusal.kind}, `
            + `${accepted.refusal.detail}`)
        }
      }
    }

    // What this module added, read back off the rows rather than asserted: which
    // desk the classifier chose, which seat every call was billed on, and the
    // reservation against the reconciliation.
    const [conv] = await sql<{ desk: string; spend_usd_micros: string }[]>`
      select desk, spend_usd_micros from course.conversations where id = ${conversationId}`
    const [turnRow] = await sql<{ status: string; fail_reason: string | null; spend_usd_micros: string }[]>`
      select status, fail_reason, spend_usd_micros from course.turns where id = ${turnId}`
    const calls = await sql<{ seat: string; model_requested: string; cost_micros: string }[]>`
      select seat, model_requested, cost_micros from course.model_calls
       where turn_id = ${turnId} order by seq`

    console.log(`desk: ${conv!.desk}, decided on step 0 and remembered on course.conversations.desk`)
    calls.forEach((call, i) => {
      console.log(`  call ${i + 1}: seat ${call.seat}, model ${call.model_requested}, `
        + dollars(BigInt(call.cost_micros)))
    })
    const routing = calls.find((c) => c.seat === 'front_desk')
    if (routing) {
      // The one reservation this script can recompute exactly, because it is a
      // constant: `selectDesk` bounds the routing call at 200 input tokens on the
      // front desk seat. The gap between the two numbers is what `reconcile`
      // gave back.
      console.log(`  routing call: reserved ${dollars(estimateMicros(SEATS.front_desk, 200))} `
        + `before dispatch, cost ${dollars(BigInt(routing.cost_micros))} after reconcile`)
    }
    const billed = calls.reduce((sum, c) => sum + BigInt(c.cost_micros), 0n)
    console.log(`spend: conversation ${dollars(BigInt(conv!.spend_usd_micros))}, `
      + `turn ${dollars(BigInt(turnRow!.spend_usd_micros))}, `
      + `${calls.length} recorded call(s) totalling ${dollars(billed)}`)
    console.log(`turn ${turnRow!.status}${turnRow!.fail_reason ? ` (${turnRow!.fail_reason})` : ''}`)
    // `renderNotebook` returns an empty string when nothing has been recorded,
    // because it is written to be appended to a request and an empty heading
    // would be noise the model pays for. A terminal is not a request, so say it.
    const rendered = renderNotebook(await loadNotebook(sql, conversationId, DEMO_USER))
    console.log('notebook:')
    console.log(rendered === '' ? '(nothing recorded yet)' : rendered)
  }

  const submitted = await submitMessage(
    { sql, invoke: process.env.TIER3 ? httpInvoke(env) : inProcess, limits: DEFAULT_LIMITS },
    {
      userId: DEMO_USER, conversationId, message: text,
      // A real client sends the same key when it retries a press; here a fresh
      // key each run just means this script's one submit is never a retry.
      idempotencyKey: randomUUID(),
    },
  )

  console.log(`conversation ${submitted.conversationId}, turn ${submitted.turnId}, ${submitted.status}`)
  // What lesson 4.3 added, read back rather than asserted: one row per item per
  // search this conversation made, still there after the reply is written.
  const [corpus] = await sql`
    select count(*)::int as rows, count(distinct source_id)::int as ids
      from course.tool_results where conversation_id = ${conversationId}`
  console.log(`corpus: ${corpus!.rows} rows in course.tool_results, ${corpus!.ids} distinct source ids`)
} finally {
  await sql.end({ timeout: 5 })
}
