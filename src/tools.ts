import type postgres from 'postgres'
import type { z } from 'zod'
import { formatMoney } from './money.js'
import { beginToolCall, finishToolCall, AmbiguousToolCallError } from './repo/toolCalls.js'
import { applyRequirementsPatch, renderNotebook } from './repo/notebook.js'
import { recordResults } from './repo/toolResults.js'
import type { Claim } from './repo/turns.js'
import type { Provenance } from './notebook.js'
import { mockSuppliers } from './supplier/mock.js'
import {
  UnusableResponseError,
  type FlightSearch, type HotelSearch, type SearchParams, type SupplierItem, type SupplierPair,
} from './supplier/types.js'
import { FlightInput, HotelInput, type Desk } from './tools/registry.js'
import { fenceResult, trimForContext, validateToolCall } from './tools/validate.js'

/** The parsed shapes `flightSearchFrom` and `hotelSearchFrom` take, from the one schema that defines them. */
export type FlightToolInput = z.infer<typeof FlightInput>
export type HotelToolInput = z.infer<typeof HotelInput>

/**
 * The trip currency when nothing better is known.
 *
 * The search currency comes from her budget, which is the one place the
 * notebook states a currency at all (`constraintsFromNotebook`,
 * src/gates/notebookConstraints.ts). A search that asked for something else
 * would build a corpus the currency gate rejects on every proposal, with no
 * re-search able to fix it, because the search is the thing that was wrong.
 *
 * EUR is the fallback for the case the notebook is honestly silent about. A
 * traveller who has named no budget has named no currency, and asking each
 * supplier for whatever it defaults to would build a MIXED corpus, which is the
 * fault `checkCurrency` files even with nothing to compare against. So the
 * fallback is one currency rather than none, and it is named here so it has a
 * single place to land rather than two call sites that can drift.
 *
 * Threaded as a parameter rather than read out of this module by the mappers,
 * so two runners alive in one process cannot disagree about which trip they are
 * searching for.
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
export function flightSearchFrom(input: FlightToolInput, currency: string | null = null): FlightSearch {
  return {
    kind: 'flight',
    from: input.from, to: input.to,
    departureDate: input.departureDate, returnDate: input.returnDate,
    flexDays: 0,
    adults: input.adults, children: input.children, infants: 0,
    cabinClass: 'Economy',
    currency: currency ?? TRIP_CURRENCY,
    maxStops: null,
    allowSelfTransfer: false,
  }
}

/** The model's hotel tool call, as a supplier search. `city` is the supplier's free-text query. */
export function hotelSearchFrom(input: HotelToolInput, currency: string | null = null): HotelSearch {
  return {
    kind: 'hotel',
    query: input.city,
    checkIn: input.checkIn, checkOut: input.checkOut,
    adults: input.adults,
    currency: currency ?? TRIP_CURRENCY,
  }
}

export type ToolOutcome = { content: string; isError: boolean }
/**
 * `callId` identifies this call WITHIN its turn, so a resumed turn can recognise
 * a call it already made. `signal` is the fence, added in lesson 4.2: a runner
 * that reaches the network hands it to the platform, so a superseded worker's
 * supplier call already in flight is cancelled rather than merely not followed
 * by another one. Declaring either is optional for an implementation: the
 * counting runner in test/crash.test.ts declares fewer parameters and still
 * satisfies this type, because a function of fewer parameters is assignable to
 * one of more, while `mockRunner` declares the call id and forwards it into the
 * lambda `supplierRunner` returns, which drops it. Calling a value typed as
 * `ToolRunner` is the other direction and does need the three required
 * arguments, which is why test/tools.test.ts passes a call id nothing
 * downstream reads.
 */
export type ToolRunner = (name: string, input: unknown, callId: string, signal?: AbortSignal) => Promise<ToolOutcome>

/**
 * True for a value shaped like a real `ToolOutcome`, not merely typed as one.
 * Unchanged from `lesson-3-7`, and it sits inside the replaced range, so it has
 * to be carried across rather than dropped: `ledgerRunner` below still calls it
 * on the `unknown` a replayed `jsonb` result comes back as. Exported from lesson
 * 5.1 for a second caller with the same problem: `toolResultBlock`
 * (src/worker.ts) has to turn that same `unknown` into the block the model
 * reads, and a tool's own error flag is worth keeping when it is really there.
 */
export function isToolOutcome(value: unknown): value is ToolOutcome {
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
export type SupplierRunner = (name: string, input: unknown, callId: string, signal?: AbortSignal) => Promise<SupplierOutcome>

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs a search against the supplier for that kind. Two failures, described
 * differently on purpose: a bad input is the model's mistake and says so, and a
 * supplier that fell over is not, and must not be reported to the model as if
 * it were. Both come back as an error result rather than a throw, because
 * `toolLoop` promises never to throw and a search is safe to try again. An
 * aborted call is the one thing that does leave here as a throw, for the
 * reason written at the catch below: it is neither of those two failures.
 */
export function supplierRunner(suppliers: SupplierPair, tripCurrency: string | null = null): SupplierRunner {
  return async (name, input, _callId, signal) => {
    if (name !== 'search_flights' && name !== 'search_hotels') {
      return { outcome: { content: `Unknown tool ${name}`, isError: true }, record: null }
    }
    let params: SearchParams
    try {
      params = name === 'search_flights'
        ? flightSearchFrom(FlightInput.parse(input), tripCurrency)
        : hotelSearchFrom(HotelInput.parse(input), tripCurrency)
    } catch (err) {
      return {
        outcome: { content: `Invalid input for ${name}: ${messageOf(err)}`, isError: true },
        record: null,
      }
    }
    const supplier = params.kind === 'flight' ? suppliers.flight : suppliers.hotel
    let items: SupplierItem[]
    try {
      items = await supplier.search(params, signal)
    } catch (err) {
      // An aborted fetch is not a supplier outage and must not be described to
      // the model as one: the turn is over, and the model is not going to get
      // another step in which to work around anything. It leaves as the
      // signal's own reason, which is the FencedError withHeartbeat captured,
      // so it lands in runTurn's catch and is written nowhere.
      if (signal?.aborted) throw signal.reason
      // A refused response is not an outage either, and the difference is the
      // model's next step. Both live adapters throw `UnusableResponseError`
      // (src/supplier/types.ts) when the supplier ANSWERED and the answer could
      // not be trusted: a currency it did not echo back, or one fare priced at
      // or below zero, which `parseKiwiResponse` refuses the whole frame over.
      // Told "search failed", a model re-issues the identical call, gets the
      // identical throw and spends its step budget on it. Told what actually
      // happened, it has something to do instead.
      //
      // "could not be trusted", not "could not be parsed": one of the two
      // causes parses perfectly and is refused for answering in a currency
      // nobody asked for. The `messageOf(err)` prefix carries which one it was,
      // and this clause has to be true of both.
      //
      // One sentence for every refusal, not one per cause. A taxonomy that
      // separates a bad payload from a timeout from a rate limit, each with its
      // own instruction, is module 5's; README.md carries it as a residual.
      if (err instanceof UnusableResponseError) {
        return {
          outcome: {
            content: `${supplier.name} answered and the response was refused: ${messageOf(err)}. `
              + 'The supplier is up. One value in the response could not be trusted, and the whole '
              + 'response was refused rather than trusted in part, so the identical search will be '
              + 'refused identically. Try the other desk, a different date, or ask her.',
            isError: true,
          },
          record: null,
        }
      }
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
 * The plain runner: a search against whichever `SupplierPair` it is handed, as
 * a tool result, with nothing recorded. The name is older than the pair, and
 * nothing about the function is a mock; only the DEFAULT is, a fresh pair of
 * mocks so every test that had no opinion about suppliers still has none.
 *
 * From lesson 4.3 nothing that runs a real turn uses it. Tier 3's driver
 * (netlify/functions/run-turn-background.mts) and `npm run trip`
 * (scripts/trip.ts) both wrap `supplierRunner` in `corpusRunner` instead, so a
 * search made by either writes its rows. What is left here is the tests, which
 * wrap `supplierRunner` rather than `corpusRunner` because they are asserting
 * something other than provenance when they call a tool at all.
 *
 * Holding a claim is NOT the separator, and reading it that way sends anyone
 * checking straight into a counterexample: `test/crash.test.ts` and
 * `test/turns.test.ts` both claim their turn and still record nothing, because
 * what they run a search through is this function. A search records when it
 * runs through `corpusRunner`, and not otherwise.
 */
export function mockRunner(suppliers: SupplierPair = mockSuppliers()): ToolRunner {
  const inner = supplierRunner(suppliers)
  return async (name, input, callId, signal) => (await inner(name, input, callId, signal)).outcome
}

/**
 * Records every search into the provenance corpus on its way back to the model.
 *
 * This is the innermost link but one: `supplierRunner` is wrapped directly by
 * this, and this is wrapped directly by `proposalRunner` (src/gates/runner.ts),
 * which draws the whole chain and is the one place that does. Naming one link
 * out and one link in rather than a composition is deliberate: lesson 4.5 and
 * lesson 4.6 each inserted a wrapper above this one, and a composition written
 * here would have gone stale twice. What matters at this level is that
 * `ledgerRunner`, the outermost link, decides whether the search runs at all,
 * `supplierRunner` makes the call, and this decides what happens to the answer.
 * One path for the mock and for the live adapters, because a corpus the mock
 * skipped would make every eval in module 6 test a system nobody ships.
 *
 * It takes the same `Claim` the ledger does, and for the same reason:
 * `recordResults` is a fenced write (src/repo/toolResults.ts), so a worker
 * superseded while its search was in flight appends nothing. That is what
 * decides the shape of this signature. Three loose ids would have been enough
 * to address the row and not enough to prove the write may still happen.
 *
 * The write happens BEFORE the outcome is handed back, which is what makes the
 * ordering right: `finishToolCall` (inside `ledgerRunner`, one layer out) marks
 * the call done only after this returns, so a replay of that call can never
 * hand the model a result whose corpus rows are not there. The gate reads the
 * corpus and nothing else; a result the model can see and the gate cannot is
 * exactly the split this module exists to close.
 *
 * The count is checked, like every writer on this branch: a search of three
 * items that recorded two is a corpus that answers two thirds of a proposal,
 * so it is treated as a failed write rather than a partial success.
 *
 * A failed corpus write is an ambiguous tool call and not an error result. The
 * supplier answered and we cannot write down what it said, so the model must
 * not be handed items it can propose and no gate can rehydrate. It leaves by
 * the same door `finishToolCall`'s own failure uses (see `ledgerRunner` below):
 * the turn ends `ambiguous_tool_call` and a person decides, which is the
 * operator step lesson 3.4 wrote down. A `FencedError` from `recordResults`
 * leaves the same way, exactly as one from `finishToolCall` does, and costs
 * nothing extra: every write that would record the ending is fenced too, so a
 * superseded worker ends its own run and not the turn.
 *
 * The cost of that door, stated because it is real: a search is read-only, so
 * unlike a hold placed or an email sent there is nothing ambiguous about the
 * outside world here. A transient corpus write failure still leaves a `pending`
 * row in `course.tool_calls` that only a person clears (src/repo/toolCalls.ts).
 * Recovering automatically would mean deciding that a search may be re-run,
 * which is true of a search and not of the tools this ledger will hold later.
 */
export function corpusRunner(sql: postgres.Sql, claim: Claim, inner: SupplierRunner): ToolRunner {
  return async (name, input, callId, signal) => {
    const { outcome, record } = await inner(name, input, callId, signal)
    if (!record) return outcome
    try {
      const written = await recordResults(sql, claim, { params: record.params, items: record.items })
      if (written !== record.items.length) {
        throw new Error(
          `corpusRunner: recorded ${written} of ${record.items.length} items for ${callId} (${name})`,
        )
      }
    } catch (err) {
      console.error(`corpusRunner: recordResults failed for ${callId} (${name})`, err)
      throw new AmbiguousToolCallError(callId, name)
    }
    return outcome
  }
}

/**
 * The desk allowlist and the schema, in front of everything durable.
 *
 * The OUTERMOST wrapper, outside `ledgerRunner`, and the order is the whole
 * point: a tool the desk does not hold, or a call whose input does not parse,
 * must not reach a `pending` row in `course.tool_calls`. Until this lesson a
 * name the model invented fell through every layer to `supplierRunner`, which
 * answered `Unknown tool <name>` after the ledger had already written that the
 * call was starting, so a turn that crashed there left a pending row a person
 * has to clear for a call that could never have run.
 *
 * On the way back it trims and then fences, in that order. Fencing first and
 * trimming second would cut the closing delimiter off a long result and hand the
 * model an unterminated fence, which is the exact structure the fence exists to
 * make unambiguous.
 *
 * The fence is applied HERE rather than inside the ledger, so what
 * `finishToolCall` stores is the raw result and every replay is fenced afresh.
 * That matters from lesson 5.5, when the delimiter carries a per-call nonce: a
 * stored fence would replay yesterday's nonce.
 *
 * A rejection is returned as an error result, not thrown, so the model gets one
 * round trip to correct itself. This is the same door a gate rejection uses
 * (src/gates/runner.ts) and for the same reason: it is something the model can
 * fix with the step it has left.
 */
export function doorRunner(desk: Desk, inner: ToolRunner): ToolRunner {
  return async (name, input, callId, signal) => {
    const check = validateToolCall(desk, name, input)
    if (!check.ok) return { content: check.content, isError: true }
    // The PARSED input goes on, never the raw one. A handler that read the raw
    // object would be reading a shape nothing checked, which is how a schema
    // becomes decoration.
    const outcome = await inner(name, check.input, callId, signal)
    return {
      content: fenceResult(check.def.name, check.def.door, trimForContext(outcome.content)),
      isError: outcome.isError,
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
 *
 * THE ONLY writer of `course.tool_calls`, and from lesson 5.1 two different
 * loops depend on that: `toolLoop` below, and `src/worker.ts`'s own loop
 * running the driver. Neither of them writes the ledger itself. A second writer
 * of the same `(turn_id, call_id)` does not double-record, it deadlocks the
 * feature: the first insert wins, the second reads back a row its own process
 * wrote moments ago, sees `pending`, and reports the call ambiguous, so every
 * tool call fails its turn with the supplier never called. Both callers instead
 * catch the `AmbiguousToolCallError` this throws and end the turn
 * `ambiguous_tool_call`.
 */
export function ledgerRunner(sql: postgres.Sql, claim: Claim, inner: ToolRunner): ToolRunner {
  return async (name, input, callId, signal) => {
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
    const result = await inner(name, input, callId, signal)
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

/** Whose notebook this patch belongs to, and who is judged to be speaking. */
export type NotebookContext = {
  conversationId: string
  userId: string
  /**
   * Read at the moment of the call, not at chain construction, because the
   * answer changes inside a turn: a patch made before any search is her words
   * and a patch made after one is not.
   */
  source: () => Provenance
  now: () => Date
}

/**
 * The `update_requirements` link of the runner chain, inside the ledger so a
 * replayed call does not apply the patch twice, and every other name falls
 * through to `inner` so this layer knows exactly one thing.
 *
 * The rejection is not a failure. `applyRequirements` (src/notebook.ts) refuses
 * three different ways: a patch that fails `PatchSchema` is refused wholesale, a
 * budget `money()` cannot read is refused on its own, and a constraint a
 * non-user patch would relax is refused on its own, so neither "recorded" nor
 * "nothing was recorded" is true in general, and the rendered notebook
 * underneath is the authoritative answer to what landed. That is why it is
 * always sent rather than only on success.
 *
 * All three come back as a tool RESULT naming the keys, never as a throw. A
 * throw out of this layer would escape `ledgerRunner` above it, which has
 * already written the `pending` row, and leave that row behind for a person to
 * clear for a call that can never complete, which is the failure `doorRunner`
 * was introduced to end.
 */
export function notebookRunner(
  sql: postgres.Sql, ctx: NotebookContext, inner: ToolRunner,
): ToolRunner {
  return async (name, input, callId, signal) => {
    if (name !== 'update_requirements') return inner(name, input, callId, signal)
    const { patch } = input as { patch: unknown }
    const { next, rejected } = await applyRequirementsPatch(sql, {
      conversationId: ctx.conversationId, userId: ctx.userId, patch,
      source: ctx.source(), at: ctx.now().toISOString(),
    })
    const head = rejected.length === 0
      ? 'Recorded. The notebook now reads:'
      : `Refused: ${rejected.join(', ')}. Do not re-send a refused key; ask her instead. `
        + 'The notebook now reads:'
    return { content: `${head}\n\n${renderNotebook(next)}`.trimEnd(), isError: false }
  }
}
