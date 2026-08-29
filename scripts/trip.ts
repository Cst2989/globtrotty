import 'dotenv/config'
import { config } from 'dotenv'
import { liveClient } from '../src/client.js'
import { HER_MESSAGE } from '../src/her.js'
import { dollars } from '../src/pricing.js'
import { handle } from '../src/router.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'

config({ path: '.env.local', override: false })

const handled = await handle(process.argv[2] ?? HER_MESSAGE, liveClient(), mockRunner(new MockSupplier()))
console.log(handled.label)
if (handled.requirements) console.log(JSON.stringify(handled.requirements, null, 2))
for (const call of handled.toolTrace) console.log(`${call.name}(${JSON.stringify(call.input)})`)
console.log(handled.text)
console.log('')
console.log(dollars(handled.costMicros))
