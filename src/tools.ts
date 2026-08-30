import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import type postgres from 'postgres'
import { z } from 'zod'
import { beginToolCall, finishToolCall, AmbiguousToolCallError } from './repo/toolCalls.js'
import type { Claim } from './repo/turns.js'
import { offerForModel } from './supplier/mock.js'
import type { MockSupplier } from './supplier/mock.js'

const FlightInput = z.object({
  from: z.string().describe('IATA code of the departure airport'),
  to: z.string().describe('IATA code of the arrival airport'),
  departureDate: z.string().describe('yyyy-mm-dd'),
  returnDate: z.string().nullable().describe('yyyy-mm-dd, or null for one way'),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
})
const HotelInput = z.object({
  city: z.string(),
  checkIn: z.string().describe('yyyy-mm-dd'),
  checkOut: z.string().describe('yyyy-mm-dd'),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
})

/** Every tool the product owns, in one list; a desk sees a subset (lesson 1.6). */
export const TOOLS: Tool[] = [
  {
    name: 'search_flights',
    description: 'Search return flights between two airports. Returns offers with a price the supplier quoted; quote those prices exactly, never a total.',
    input_schema: z.toJSONSchema(FlightInput) as Tool['input_schema'],
  },
  {
    name: 'search_hotels',
    description: 'Search hotels in a city for a stay. Returns offers priced for the whole stay; quote those prices exactly.',
    input_schema: z.toJSONSchema(HotelInput) as Tool['input_schema'],
  },
]

export type ToolOutcome = { content: string; isError: boolean }
/**
 * `callId` identifies this call WITHIN its turn, so a resumed turn can recognise
 * a call it already made. A runner that does not care about identity, like
 * `mockRunner` below, declares two parameters and still satisfies this type,
 * because a function of fewer parameters is assignable to one of more. Calling
 * a value typed as `ToolRunner` is the other direction and does need all three,
 * which is why test/tools.test.ts passes a call id it then ignores.
 */
export type ToolRunner = (name: string, input: unknown, callId: string) => Promise<ToolOutcome>

/** True for a value shaped like a real `ToolOutcome`, not merely typed as one. */
function isToolOutcome(value: unknown): value is ToolOutcome {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).content === 'string'
    && typeof (value as Record<string, unknown>).isError === 'boolean'
}

/** Runs a tool against the mock supplier; a bad input comes back as an error the model can read and correct. */
export function mockRunner(supplier: MockSupplier): ToolRunner {
  return async (name, input) => {
    try {
      if (name === 'search_flights') {
        return { content: JSON.stringify(supplier.searchFlights(FlightInput.parse(input)).map(offerForModel)), isError: false }
      }
      if (name === 'search_hotels') {
        return { content: JSON.stringify(supplier.searchHotels(HotelInput.parse(input)).map(offerForModel)), isError: false }
      }
      return { content: `Unknown tool ${name}`, isError: true }
    } catch (err) {
      return { content: `Invalid input for ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
}

/**
 * Any runner, made safe to run twice. The ledger decides whether the inner
 * runner is called at all, so a crash between the supplier answering and the
 * turn recording it costs one wasted call and never a second one. Takes the
 * `Claim` rather than a bare `turnId` because `beginToolCall` and
 * `finishToolCall` both write with the fencing token now: a superseded worker
 * must not be able to write intent, or record an outcome, for a turn it no
 * longer owns.
 *
 * Wrapping rather than teaching `mockRunner` about the database keeps one
 * responsibility per file: `mockRunner` knows about the supplier, this knows
 * about crashes, and lesson 4's live adapters get the same protection by being
 * wrapped in exactly the same way.
 */
export function ledgerRunner(sql: postgres.Sql, claim: Claim, inner: ToolRunner): ToolRunner {
  return async (name, input, callId) => {
    const outcome = await beginToolCall(sql, claim, callId, name)
    if (outcome.status === 'replayed') {
      // `result` is `unknown`: it came back through a `jsonb` column the type
      // system never saw written, and a row from an older version of this
      // code is a real possibility once the table outlives one deploy.
      // Trusting an unchecked cast here would hand `src/loop.ts` a shape it
      // reads `.content` and `.isError` off without checking, inside a loop
      // that promises never to throw. A shape that fails the check is treated
      // the same as `ambiguous`: this runner cannot produce a trustworthy
      // result for the call, and stopping is safer than guessing one.
      if (!isToolOutcome(outcome.result)) throw new AmbiguousToolCallError(callId, name)
      return outcome.result
    }
    if (outcome.status === 'ambiguous') throw new AmbiguousToolCallError(callId, name)
    const result = await inner(name, input, callId)
    try {
      await finishToolCall(sql, claim, callId, result)
    } catch {
      // The tool ran and we could not write that down. That is the ambiguous
      // case by definition, so it leaves by the same door rather than
      // escaping toolLoop, which promises never to throw.
      throw new AmbiguousToolCallError(callId, name)
    }
    return result
  }
}
