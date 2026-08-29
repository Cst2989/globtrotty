import 'dotenv/config'
import { config } from 'dotenv'
import { liveClient } from '../src/client.js'
import { HER_MESSAGE } from '../src/her.js'
import { dollars } from '../src/pricing.js'
import { handle } from '../src/router.js'

config({ path: '.env.local', override: false })

const handled = await handle(process.argv[2] ?? HER_MESSAGE, liveClient())
console.log(handled.label)
if (handled.requirements) console.log(JSON.stringify(handled.requirements, null, 2))
console.log(handled.text)
console.log('')
console.log(dollars(handled.costMicros))
