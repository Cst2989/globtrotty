import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { liveClient, type ModelClient } from '../../src/client.js'

type Exchange = { request: MessageCreateParamsNonStreaming; response: Message }

export type ReplayClient = ModelClient & {
  /** Call once at the end of a test: writes the recording, or checks every recorded call was used. */
  done(): void
}

const DIR = path.join(process.cwd(), 'test', 'fixtures', 'model')

/**
 * Replays recorded model calls in order, so a test runs without a key and
 * without variance. With RECORD_MODEL=1 it records against the live API
 * instead and writes the fixture on done().
 */
export function replayClient(name: string): ReplayClient {
  const file = path.join(DIR, `${name}.json`)
  if (process.env.RECORD_MODEL === '1') {
    const live = liveClient()
    const exchanges: Exchange[] = []
    return {
      async create(request) {
        const response = await live.create(request)
        exchanges.push({ request, response })
        return response
      },
      done() {
        mkdirSync(DIR, { recursive: true })
        writeFileSync(file, JSON.stringify(exchanges, null, 2) + '\n')
      },
    }
  }
  if (!existsSync(file)) {
    throw new Error(`No fixture at ${file}. Record it with RECORD_MODEL=1 and ANTHROPIC_API_KEY set.`)
  }
  const exchanges = JSON.parse(readFileSync(file, 'utf8')) as Exchange[]
  let next = 0
  return {
    async create(request) {
      const exchange = exchanges[next]
      if (!exchange) throw new Error(`Fixture ${name} holds ${exchanges.length} calls and the test asked for one more.`)
      // Matched on the model and on nothing else, deliberately. A fixture that
      // also compared the request body would go red on every prompt edit and on
      // every cache breakpoint move, which is a fixture that gets deleted rather
      // than a fixture that catches anything. The request's SHAPE is pinned
      // somewhere a fixture cannot be: test/request-shape.test.ts asserts what
      // `buildRequest` assembles, field by field, with no key and no network, so
      // the thing a body comparison would have guarded is already guarded and is
      // guarded by an assertion a reader can read.
      if (exchange.request.model !== request.model) {
        throw new Error(`Fixture ${name}, call ${next + 1}: recorded ${exchange.request.model}, test sent ${request.model}.`)
      }
      next += 1
      return exchange.response
    },
    done() {
      if (next !== exchanges.length) {
        throw new Error(`Fixture ${name}: ${exchanges.length - next} recorded calls were never used.`)
      }
    },
  }
}
