import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import type postgres from 'postgres'
import { z } from 'zod'
import { formatMoney } from './money.js'
import { beginToolCall, finishToolCall, AmbiguousToolCallError } from './repo/toolCalls.js'
import type { Claim } from './repo/turns.js'
import { mockSuppliers } from './supplier/mock.js'
import type {
  FlightSearch, HotelSearch, SearchParams, SupplierItem, SupplierPair,
} from './supplier/types.js'

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
    description: 'Search return flights between two airports. Returns offers with a price the supplier quoted, its age and how long it stays quotable. Quote those prices exactly, never a total you worked out yourself.',
    input_schema: z.toJSONSchema(FlightInput) as Tool['input_schema'],
  },
  {
    name: 'search_hotels',
    description: 'Search hotels in a city for a stay. Returns offers priced for the whole stay, with the price\'s age. Quote those prices exactly, never a total you worked out yourself.',
    input_schema: z.toJSONSchema(HotelInput) as Tool['input_schema'],
  },
]

export type FlightToolInput = z.infer<typeof FlightInput>
export type HotelToolInput = z.infer<typeof HotelInput>

/**
 * The trip currency, until the notebook's budget currency can reach a tool.
 *
 * Every search in this branch asks for one currency, and it is this one, not
 * because EUR is special but because a search that asked for whatever each
 * supplier defaults to would produce a mixed corpus and a currency violation on
 * every proposal. The notebook already knows the real answer
 * (`budget.value.currency`), and the tool runner is built outside `turn()` and
 * cannot see it: closing that is module 5.2's, where the tool registry moves
 * inside the harness and a tool gets the turn's own context. Named as a
 * constant rather than inlined at two call sites so that change has one place
 * to land.
 */
export const TRIP_CURRENCY = 'EUR'

/**
 * The model's flight tool call, as a supplier search. Every field the port
 * needs and the tool does not publish gets its conservative value here rather
 * than a supplier default: `maxStops: null` asks for no filter, and
 * `allowSelfTransfer: false` refuses virtual interlining, where a missed
 * connection is the traveller's problem. Neither is a value the model may set,
 * because neither is a thing she asked for.
 */
export function flightSearchFrom(input: FlightToolInput): FlightSearch {
  return {
    kind: 'flight',
    from: input.from, to: input.to,
    departureDate: input.departureDate, returnDate: input.returnDate,
    flexDays: 0,
    adults: input.adults, children: input.children, infants: 0,
    cabinClass: 'Economy',
    currency: TRIP_CURRENCY,
    maxStops: null,
    allowSelfTransfer: false,
  }
}

/** The model's hotel tool call, as a supplier search. `city` is the supplier's free-text query. */
export function hotelSearchFrom(input: HotelToolInput): HotelSearch {
  return {
    kind: 'hotel',
    query: input.city,
    checkIn: input.checkIn, checkOut: input.checkOut,
    adults: input.adults,
    currency: TRIP_CURRENCY,
  }
}

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

/**
 * True for a value shaped like a real `ToolOutcome`, not merely typed as one.
 * Unchanged from `lesson-3-7`, and it sits inside the replaced range, so it has
 * to be carried across rather than dropped: `ledgerRunner` below still calls it
 * on the `unknown` a replayed `jsonb` result comes back as.
 */
function isToolOutcome(value: unknown): value is ToolOutcome {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).content === 'string'
    && typeof (value as Record<string, unknown>).isError === 'boolean'
}

/**
 * What a tool result looks like on the wire. `Money` holds a bigint and
 * JSON.stringify throws on those, which is a useful accident: it forces one
 * deliberate answer to "what does the model see?" instead of a silent one. The
 * model sees the formatted price and the exact minor units beside it, so a
 * reply can quote either and `test/provenance-v0.test.ts` can check both.
 *
 * `bookingUrl` is deliberately NOT on the wire. It is supplier-supplied text,
 * and a desk that holds her private data, reads untrusted listings and emits
 * URLs is a complete exfiltration path that fencing does not touch, because a
 * URL is not prompt text. Lesson 4.6 builds every link she is given from
 * `(supplier, sourceId, tracking ref)` server side, against a per-supplier
 * template with an allowlisted host; nothing the model saw is ever the thing
 * she clicks.
 */
export function itemForModel(item: SupplierItem): Record<string, unknown> {
  return {
    sourceId: item.sourceId,
    supplier: item.supplier,
    kind: item.kind,
    name: item.name,
    price: {
      minor: item.price.minor.toString(),
      currency: item.price.currency,
      formatted: formatMoney(item.price),
    },
    priceBasis: item.priceBasis,
    fetchedAt: item.fetchedAt.toISOString(),
    ttlSeconds: item.ttlSeconds,
    detail: item.detail,
  }
}

/** What a search actually returned, kept alongside the outcome so lesson 4.3 can store it. */
export type SearchRecord = { params: SearchParams; items: SupplierItem[] }
export type SupplierOutcome = { outcome: ToolOutcome; record: SearchRecord | null }

/**
 * A runner that returns the typed items as well as the string the model reads.
 * Two consumers want two different things out of one call: the loop wants a
 * tool result, and lesson 4.3's corpus wants `SupplierItem`s with their `Date`
 * and their `bigint` intact. Re-parsing the JSON to recover them would lose
 * both types and would store the model's view rather than the supplier's.
 */
export type SupplierRunner = (name: string, input: unknown, callId: string) => Promise<SupplierOutcome>

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs a search against the supplier for that kind. Two failures, described
 * differently on purpose: a bad input is the model's mistake and says so, and a
 * supplier that fell over is not, and must not be reported to the model as if
 * it were. Both come back as an error result rather than a throw, because
 * `toolLoop` promises never to throw and a search is safe to try again.
 */
export function supplierRunner(suppliers: SupplierPair): SupplierRunner {
  return async (name, input) => {
    if (name !== 'search_flights' && name !== 'search_hotels') {
      return { outcome: { content: `Unknown tool ${name}`, isError: true }, record: null }
    }
    let params: SearchParams
    try {
      params = name === 'search_flights'
        ? flightSearchFrom(FlightInput.parse(input))
        : hotelSearchFrom(HotelInput.parse(input))
    } catch (err) {
      return {
        outcome: { content: `Invalid input for ${name}: ${messageOf(err)}`, isError: true },
        record: null,
      }
    }
    const supplier = params.kind === 'flight' ? suppliers.flight : suppliers.hotel
    let items: SupplierItem[]
    try {
      items = await supplier.search(params)
    } catch (err) {
      return {
        outcome: { content: `${supplier.name} search failed: ${messageOf(err)}`, isError: true },
        record: null,
      }
    }
    return {
      outcome: { content: JSON.stringify(items.map(itemForModel)), isError: false },
      record: { params, items },
    }
  }
}

/**
 * The plain runner: a search, as a tool result, with nothing recorded. Defaults
 * to a fresh pair of mocks so every test and script that had no opinion about
 * suppliers still has none. Lesson 4.3 wraps `supplierRunner` in `corpusRunner`
 * instead, and from then on this is the runner for code paths with no
 * conversation to attach a corpus row to.
 */
export function mockRunner(suppliers: SupplierPair = mockSuppliers()): ToolRunner {
  const inner = supplierRunner(suppliers)
  return async (name, input, callId) => (await inner(name, input, callId)).outcome
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
