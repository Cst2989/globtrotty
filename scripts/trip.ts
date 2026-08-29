import 'dotenv/config'
import { config } from 'dotenv'
import { liveClient } from '../src/client.js'
import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { notebookForPrompt } from '../src/notebook.js'
import { dollars } from '../src/pricing.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'

config({ path: '.env.local', override: false })

const client = liveClient()
const run = mockRunner(new MockSupplier())

// Two turns on one conversation: her first message, then the follow-up that
// lowers her budget. The notebook printed after each turn is the proof that
// the second turn planned from what she said on both, not only the last one.
const messages = [HER_MESSAGE, 'Actually, let us keep it under 1,200 euros.']

let conversation = newConversation()
for (const text of messages) {
  const result = await turn(conversation, text, client, run)
  conversation = result.conversation
  console.log(`> ${text}`)
  console.log(`${result.desk} desk, outcome ${result.outcome} (${result.steps} step${result.steps === 1 ? '' : 's'})`)
  for (const call of result.toolTrace) console.log(`${call.name}(${JSON.stringify(call.input)})`)
  console.log(result.text)
  console.log(dollars(result.costMicros))
  console.log('notebook:')
  console.log(notebookForPrompt(conversation.notebook))
  console.log('')
}
