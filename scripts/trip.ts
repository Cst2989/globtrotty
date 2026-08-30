import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import { config } from 'dotenv'
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
    const notebook = constraintsFromNotebook(emptyNotebook())
    const result = await turn(
      newConversation(conversationId),
      text,
      liveClient(),
      // The same chain tier 3 runs (netlify/functions/run-turn-background.mts),
      // minus the ledger: one process, no crash to resume from, and nothing
      // here replays a tool call. The other three layers are not optional. The
      // planning desk is handed `propose_itinerary` on every path (src/desks.ts)
      // and is told in its prompt to use it, so a chain without `proposalRunner`
      // answers the model "Unknown tool propose_itinerary" from the innermost
      // link and this command can search but never propose. The corpus records
      // what a search returned, and the searches ask for the SAME currency the
      // gates expect, off the same constraints object, so a corpus and the
      // currency gate cannot disagree by construction.
      proposalRunner(
        sql,
        { conversationId, userId: DEMO_USER, turnId, notebook, now: () => new Date() },
        corpusRunner(sql, claim, supplierRunner(suppliers, notebook.currency)),
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
