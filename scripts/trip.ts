import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import { config } from 'dotenv'
import { cashierRunner } from '../src/cashier.js'
import { liveClient } from '../src/client.js'
import { newConversation, turn } from '../src/conversation.js'
import { connect } from '../src/db.js'
import { loadEnv } from '../src/env.js'
import { constraintsFromNotebook } from '../src/gates/pipeline.js'
import { proposalRunner } from '../src/gates/runner.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_USER, HER_MESSAGE } from '../src/her.js'
import { httpInvoke } from '../src/invoke.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { emptyNotebook, notebookForPrompt } from '../src/notebook.js'
import { dollars } from '../src/pricing.js'
import { ledgerSink } from '../src/repo/spend.js'
import { claimTurn } from '../src/repo/turns.js'
import { liveSuppliers } from '../src/supplier/live.js'
import { corpusRunner, supplierRunner } from '../src/tools.js'

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

  const inProcess = async (turnId: string) => {
    console.log(`turn ${turnId} is durable; running it now. Press ctrl-c to kill it.`)
    // Claim the turn before running it, which this script did not have to do
    // while it recorded nothing. From lesson 4.3 it writes to the provenance
    // corpus, and every write a worker makes carries the claim's fencing token
    // (src/repo/toolResults.ts), so a script that ran the turn as nobody could
    // not append a row. Claiming is also the truer description of what this
    // process is doing: it is the worker for this turn, in the same sense
    // tier 3's background function is for its own.
    //
    // What it does NOT do is close the turn afterwards. `runTurn`
    // (src/worker.ts) is what completes a turn, and this script deliberately
    // stays the two-file demo lesson 2.1 built; the row it leaves behind is
    // module 3's sweeper's to reap, exactly as the queued row it used to leave
    // was.
    const claim = await claimTurn(sql, turnId)
    if (!claim) throw new Error(`trip: turn ${turnId} is owned by another worker`)
    // Her constraints through the one mapper, exactly as tier 3 derives them,
    // and empty for the same reason: nothing on this branch stores a notebook,
    // so budget, window and currency are all null here and every proposal this
    // command produces records `budget` and `dates` as not evaluated with a
    // reason. The day a conversation stores a notebook, this line reads that
    // one and nothing else in the chain moves.
    const ctx = { conversationId, userId: DEMO_USER, turnId }
    const notebook = constraintsFromNotebook(emptyNotebook())
    const result = await turn(
      newConversation(conversationId),
      text,
      liveClient(),
      // The same chain tier 3 runs (netlify/functions/run-turn-background.mts),
      // minus the ledger: one process, no crash to resume from, and nothing
      // here replays a tool call.
      //
      // `hand_off_to_booking` is the one tool in this chain the missing ledger
      // would matter for, and it is left out anyway. On tier 3 the ledger is
      // what makes a crash between minting the course.link_clicks rows and
      // recording the tool result end the turn `ambiguous_tool_call` instead of
      // emitting a second set of links; here there is no second attempt to
      // protect, because ctrl-c kills the only process there is and the row it
      // leaves is the sweeper's to reap. The cashier's own refusal covers the
      // rest: a proposal that already emitted is refused before it is
      // re-quoted, whichever chain asks.
      //
      // All four wrappers, not just the corpus one. The planning desk's tool
      // list is `DESK_TOOLS.planning` (src/desks.ts) and it holds
      // `propose_itinerary` and `hand_off_to_booking`, so a chain that stopped
      // at `supplierRunner` would publish two tools to the model and answer
      // "Unknown tool" to both. That is not a missing feature the model can
      // route around: it reads as an outage, and the reply it writes tells her
      // our proposal system is down. The chain is the product's, so this script
      // runs the product's. The searches ask for the SAME currency the gates
      // expect, off the same constraints object, so a corpus and the currency
      // gate cannot disagree by construction.
      //
      // The notebook is empty here for the same reason it is empty in tier 3:
      // nothing on this branch stores one, and `turn()` builds its own inside
      // itself while this runner is constructed outside it. So `budget` and
      // `dates` record as not evaluated on every proposal this command makes,
      // which is what the README says of the path a reader can run.
      cashierRunner(
        sql, ctx,
        { suppliers, limits: DEFAULT_LIMITS, now: () => new Date() },
        proposalRunner(
          sql,
          { ...ctx, notebook, now: () => new Date() },
          corpusRunner(sql, claim, supplierRunner(suppliers, notebook.currency)),
        ),
      ),
      {
        // ledgerSink, not the bare model_calls sink: this is the one path in
        // the whole course that calls a live model and spends real dollars,
        // and pgSink alone would write rows to course.model_calls while
        // leaving conversations.spend_usd_micros and daily_usage.cost_micros
        // at zero forever, which is exactly the ceiling this lesson exists to
        // enforce. loadEnv already refused to start this script without
        // DATABASE_URL, so `sql` is always connected here. No `readSpend` is
        // passed: this script records what it spends but does not enforce a
        // ceiling on itself, so a run here always completes rather than
        // stopping partway through the demo.
        record: ledgerSink(sql, { userId: DEMO_USER, conversationId, turnId }),
      },
    )
    console.log(result.text)
    console.log(`outcome ${result.outcome}, ${result.steps} steps, ${dollars(result.costMicros)}`)
    console.log('notebook:')
    console.log(notebookForPrompt(result.conversation.notebook))
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
