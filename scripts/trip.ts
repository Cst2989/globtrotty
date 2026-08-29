import 'dotenv/config'
import { config } from 'dotenv'
import { liveClient } from '../src/client.js'
import { newConversation, turn } from '../src/conversation.js'
import { connect } from '../src/db.js'
import { loadEnv } from '../src/env.js'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'
import { notebookForPrompt } from '../src/notebook.js'
import { dollars } from '../src/pricing.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'

config({ path: '.env.local', override: false })
const env = loadEnv(process.env)

// A demo user id, so the script can run without a login.
const USER = '11111111-1111-1111-1111-111111111111'

const sql = connect(env.DATABASE_URL)
const text = process.argv[2] ?? HER_MESSAGE
try {
  // The conversation row is created here rather than by submitMessage, because
  // the in-process invoke below needs its id: the Conversation the loop works on
  // and the conversation the database holds have to be the same one, or the
  // reply is written against a row nobody will read. Lesson 2.2 removes this,
  // because the background function loads the id from the turn itself.
  const [row] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  const conversationId = row!.id as string

  const submitted = await submitMessage({
    sql,
    invoke: async (turnId) => {
      console.log(`turn ${turnId} is durable; running it now. Press ctrl-c to kill it.`)
      const result = await turn(
        newConversation(conversationId),
        text,
        liveClient(),
        mockRunner(new MockSupplier()),
      )
      console.log(result.text)
      console.log(`outcome ${result.outcome}, ${result.steps} steps, ${dollars(result.costMicros)}`)
      console.log('notebook:')
      console.log(notebookForPrompt(result.conversation.notebook))
    },
  }, { userId: USER, conversationId, message: text })

  console.log(`conversation ${submitted.conversationId}, turn ${submitted.turnId}, ${submitted.status}`)
} finally {
  await sql.end({ timeout: 5 })
}
