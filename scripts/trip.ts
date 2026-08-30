import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import { config } from 'dotenv'
import { liveClient } from '../src/client.js'
import { newConversation, turn } from '../src/conversation.js'
import { connect } from '../src/db.js'
import { loadEnv } from '../src/env.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_USER, HER_MESSAGE } from '../src/her.js'
import { httpInvoke } from '../src/invoke.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { notebookForPrompt } from '../src/notebook.js'
import { dollars } from '../src/pricing.js'
import { ledgerSink } from '../src/repo/spend.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'

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
  const inProcess = async (turnId: string) => {
    console.log(`turn ${turnId} is durable; running it now. Press ctrl-c to kill it.`)
    const result = await turn(
      newConversation(conversationId),
      text,
      liveClient(),
      mockRunner(new MockSupplier()),
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
} finally {
  await sql.end({ timeout: 5 })
}
