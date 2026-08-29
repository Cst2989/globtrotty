import 'dotenv/config'
import { config } from 'dotenv'
import { ask } from '../src/ask.js'
import { HER_MESSAGE } from '../src/her.js'
import { dollars } from '../src/pricing.js'

config({ path: '.env.local', override: false })

const answer = await ask(HER_MESSAGE)
console.log(answer.text)
console.log('')
console.log(`model ${answer.model}, ${answer.usage.input_tokens} in, ${answer.usage.output_tokens} out, ${dollars(answer.costMicros)}`)
