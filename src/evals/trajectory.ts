import type postgres from 'postgres'
import { minorUnitExponent } from '../money.js'
import { rehydrate } from '../repo/toolResults.js'
import { recordTurnLabels, type TurnCounters } from '../repo/turnLabels.js'
import type { SupplierItem } from '../supplier/types.js'

/**
 * One tool call the agency made, named, identified, and placed in its turn.
 *
 * `questions` is the ARITY of an `ask_user` call and zero for every other tool.
 * It is a field rather than a derived one because a question is not a call:
 * `AskUser` (src/tools/registry.ts) carries one to three question strings per
 * call, so a check that counted calls and printed them as questions would
 * understate what the agency put to her by up to three times. It counts what the
 * model asked for, which for a schema-rejected call is more than reached her:
 * `validateToolCall` refuses the whole call and she is sent a correction
 * instead, and those are the only `ask_user` calls a turn ever continues past.
 */
export type TraceCall = {
  name: string; callId: string; turnId: string; seq: number; questions: number
}

export type Trace = {
  turnIds: string[]
  calls: TraceCall[]
  replies: string[]
  /** Every source id this conversation's corpus holds, which is what provenance means here. */
  sourceIds: Set<string>
  /** Every amount the agency wrote into prose, in whole units. */
  quoted: number[]
}

/** A count over a count, never a percentage on its own. */
export type Rate = { numerator: number; denominator: number }

/**
 * Every amount in a reply that reads like money.
 *
 * Written here rather than reused from test/helpers/provenance.ts, which is
 * lesson 1.4's retired check: `test/regressions.test.ts` fails any test file but
 * two that names `offeredAmounts`, and that retirement is deliberate. That guard
 * walks the test tree and only the test tree, so this one lives in src/ because
 * it is production-adjacent code a scorecard depends on rather than because src/
 * is out of the grep's sight. It is currency-aware where the retired one was
 * blind, because a trace has the corpus beside it and can compare like with
 * like.
 */
export function quotedAmountsIn(text: string): number[] {
  const out: number[] = []
  const pattern = /(?:€|\$|EUR|USD)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:€|\$|EUR|USD|euros|dollars)/gi
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? match[2]
    if (raw) out.push(Number(raw.replace(/[.,](?=\d{3}\b)/g, '')))
  }
  return out
}

/**
 * What one run of one conversation left behind, read from the rows the system
 * already writes.
 *
 * ## Where the calls come from, and the two tables they do not come from
 *
 * `course.tool_calls` is the obvious table and the wrong one twice over, which
 * lesson 6.3 established and this function inherits. `ledgerRunner` is its only
 * writer (src/tools.ts) and both the eval chain and `scripts/trip.ts` drop that
 * wrapper, so it holds nothing at all for a run of this suite. Even on tier 3,
 * where the ledger runs, `ask_user` returns from the driver before `deps.run`
 * is ever called (src/agents/driver.ts), so the one tool this lesson counts is
 * the one tool that table cannot see.
 *
 * `course.turns.state` is the transcript `completeTurn` persists, and it is
 * where the reader this function replaced took its calls until this lesson
 * removed it (`callsOf`, src/evals/runner.ts at lesson-6-4, gone from the tree
 * now). It holds every tool the CHAIN answered and
 * precisely not the tool that ended the turn. A valid `ask_user` comes back from
 * the driver as a `message` step, and the worker's message branch returns before
 * the transcript append at the bottom of its loop (src/worker.ts), so that
 * `tool_use` block is never persisted anywhere in `state`. The database says the
 * same thing: every `ask_user` block sitting in a stored transcript carries an
 * `is_error` tool result beside it, because those are the SCHEMA-REJECTED asks,
 * which are the only ones that ever reach a second step. Counting questions
 * there counts the malformed ones and nothing else.
 *
 * `course.model_calls.response` is the model's own reply, captured in full for
 * the driver seat on every call and never sampled (`capturePolicyFor`,
 * src/repo/model-calls.ts), carrying `turn_id` and the `seq` that orders it. The
 * tool the driver acted on is in it whether the chain answered the call or the
 * turn ended on it, so it is the only source in this schema that holds a valid
 * `ask_user`. It is read here for the calls, and `course.messages` and
 * `course.tool_results` are read beside it for the replies and the corpus.
 *
 * The FIRST `tool_use` block of each response and not every one, because
 * `makeDriver` answers exactly one per response and drops the siblings from the
 * transcript it echoes back (src/agents/driver.ts): a second block is a call the
 * model asked for and the agency never made, and counting it would report work
 * nobody did. So these are the calls that were EXECUTED, not the calls that were
 * EMITTED, and the difference is not small: the three shipped recordings carry
 * 59, 107 and 140 `tool_use` blocks and the harness ran 22, 50 and 68 of them.
 * The executed count is the one this trace carries because it is the one that
 * spends money and supplier quota, and the emitted count is the one a prompt
 * change would move. `with ordinality` rather than a bare `limit 1`, so "first"
 * is the array's order and not the order a function scan happened to emit.
 *
 * `callId` is the provider's own block id rather than the ledger's positional
 * key, for the reason lesson 6.3 gave: this trace identifies a call inside
 * itself and has no ledger row to join to.
 *
 * ## What each read is scoped by
 *
 * Calls and replies are scoped to the TURNS asked for, so a caller can load one
 * turn's slice without filtering afterwards, which is what the per-turn label
 * row needs. The corpus is scoped to the CONVERSATION, and that difference is
 * deliberate: a price quoted in the fourth turn is backed by a search made in
 * the first, so a corpus narrowed to one turn would report an honest quote as an
 * invention.
 */
export async function loadTrace(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; turnIds: string[] },
): Promise<Trace> {
  const empty: Trace = {
    turnIds: args.turnIds, calls: [], replies: [], sourceIds: new Set(), quoted: [],
  }
  if (args.turnIds.length === 0) return empty

  const calls = await sql<
    { turn_id: string; call_id: string; name: string; questions: number }[]
  >`
    select mc.turn_id, first.name, first.call_id, first.questions
      from course.model_calls mc
      cross join lateral (
        select b.value->>'name' as name, b.value->>'id' as call_id,
               case when jsonb_typeof(b.value->'input'->'questions') = 'array'
                    then jsonb_array_length(b.value->'input'->'questions')
                    else 0 end as questions
          from jsonb_array_elements(mc.response->'content') with ordinality as b(value, ord)
         where b.value->>'type' = 'tool_use'
         order by b.ord
         limit 1
      ) first
     where mc.conversation_id = ${args.conversationId}
       and mc.user_id = ${args.userId}
       and mc.turn_id = any(${args.turnIds})
       -- The seat the desk's tools are published to. A scout or a front desk
       -- call is a model call this conversation paid for and not a tool the
       -- agency reached for, and counting one would put routing in a number
       -- about the path.
       and mc.seat = 'driver'
       and jsonb_typeof(mc.response->'content') = 'array'
     order by mc.seq`
  const replies = await sql<{ content: string }[]>`
    select content from course.messages
     where conversation_id = ${args.conversationId} and user_id = ${args.userId}
       and role = 'agent' and turn_id = any(${args.turnIds})
     order by seq`
  const corpus = await sql<{ source_id: string }[]>`
    select distinct source_id from course.tool_results
     where conversation_id = ${args.conversationId} and user_id = ${args.userId}`
  const text = replies.map((r) => r.content).join('\n')
  return {
    turnIds: args.turnIds,
    calls: calls.map((c, i) => ({
      name: c.name, callId: c.call_id, turnId: c.turn_id, seq: i,
      // Read off the one tool that has an arity, never off any other tool that
      // happens to publish a field called `questions`.
      questions: c.name === 'ask_user' ? Number(c.questions) : 0,
    })),
    replies: replies.map((r) => r.content),
    sourceIds: new Set(corpus.map((c) => c.source_id)),
    quoted: quotedAmountsIn(text),
  }
}

/**
 * How many of the amounts the agency wrote match a price the corpus holds.
 *
 * A RATE and not a boolean, with its denominator, because "one price in this
 * reply was invented" and "every price in this reply was invented" want
 * different work, and a suite that reported both as `false` could not tell a
 * regression from a catastrophe.
 *
 * A reply with no amounts in it has a denominator of zero and is not a pass: it
 * is a reply the check could not look at, and the scorecard files it as not
 * evaluated for the same reason course.gate_results has three verdicts.
 */
export function provenanceRate(trace: Trace, priced: Map<string, SupplierItem>): Rate {
  const known = new Set(
    [...priced.values()].map((i) => Number(i.price.minor) / 10 ** minorUnitExponent(i.price.currency)),
  )
  return {
    numerator: trace.quoted.filter((q) => known.has(q)).length,
    denominator: trace.quoted.length,
  }
}

/**
 * Whether the agency asked before it guessed.
 *
 * The rule is not "never search first". It is that a conversation which fires a
 * SUPPLIER search before it has asked anything is spending money against an
 * unknown budget, and P3's example is the discovery opener: "somewhere warm?"
 * with four searches behind it. A conversation that asked nothing at all and
 * searched nothing at all passes, because it guessed nothing.
 */
export function questionsBeforeGuesses(trace: Trace): boolean {
  const firstQuestion = trace.calls.findIndex((c) => c.name === 'ask_user')
  const firstSearch = trace.calls.findIndex((c) => c.name.startsWith('search_'))
  if (firstSearch === -1) return true
  if (firstQuestion === -1) return false
  return firstQuestion < firstSearch
}

/**
 * A claim about entry requirements is the branch's version of P3's
 * "I've checked the visa rules for you".
 *
 * P3's scene names `check_entry_rules`, and this branch does not have that tool:
 * SPEC section 5's non-goals removed it, and `research_destination` (lesson 5.4)
 * is what a desk actually reaches for. So the scene is re-anchored on the claim
 * rather than on the tool name, which is truer to the built system.
 *
 * Nothing in production watches for this sentence today, and the shape of what
 * does watch is the argument for reading it here. `src/monitor.ts` is handed a
 * JSON summary of a turn, how many tools it started and finished, how many
 * searches, how many proposals, what it spent, and it never sees a word the
 * agency wrote. A monitor over shapes cannot tell these two sentences apart
 * because the two sentences are not in front of it. This check is the half that
 * reads the prose, offline, where a false alarm costs a scorecard row rather
 * than a turn.
 */
export const ENTRY_CLAIM =
  /\b(visa|entry (?:rules|requirements)|passport)\b[^.]*\b(check|checked|confirm|confirmed|looked up)\b|\b(check|checked|confirm|confirmed|looked up)\b[^.]*\b(visa|entry (?:rules|requirements)|passport)\b/i

/** Every reply that announced work the trace shows no call behind. */
export function announcedButNeverCalled(trace: Trace): string[] {
  const researched = trace.calls.some((c) => c.name === 'research_destination')
  if (researched) return []
  return trace.replies.filter((r) => ENTRY_CLAIM.test(r))
}

/** The counters the label row holds, from the trace of one turn. */
export function countersOf(trace: Trace, priced: Map<string, SupplierItem>): TurnCounters {
  const provenance = provenanceRate(trace, priced)
  const firstQuestion = trace.calls.findIndex((c) => c.name === 'ask_user')
  const before = firstQuestion === -1 ? trace.calls : trace.calls.slice(0, firstQuestion)
  return {
    toolCalls: trace.calls.length,
    // Questions and not `ask_user` calls, for the reason written on
    // `TraceCall.questions`: the column is called questions_asked and one call
    // can carry three of them.
    questionsAsked: trace.calls.reduce((n, c) => n + c.questions, 0),
    searchesBeforeFirstQuestion: before.filter((c) => c.name.startsWith('search_')).length,
    pricesQuoted: provenance.denominator,
    unbackedPrices: provenance.denominator - provenance.numerator,
  }
}

/**
 * Counts one finished turn and writes its label row. BEST EFFORT, and logged
 * with the turn id rather than swallowed.
 *
 * A label write that fails must not lose a turn that succeeded, and a turn with
 * no label row is DISTINGUISHABLE from a turn whose counters are zero, which is
 * what keeps the rate honest: `readTurnLabels` returns fewer rows than there
 * were turns, and the scorecard's denominator is turns.
 *
 * One function rather than one at each call site, because the eval and the
 * worker have to count the same way or the corpus module 7 trains on is two
 * definitions of a question wearing one column name.
 *
 * Called AFTER the turn's ending is written, never before, because the reply is
 * part of what is counted and `completeTurn` is what writes it to
 * `course.messages`.
 */
export async function labelTurn(
  sql: postgres.Sql, args: { turnId: string; conversationId: string; userId: string },
): Promise<void> {
  try {
    const trace = await loadTrace(sql, { ...args, turnIds: [args.turnId] })
    const priced = await rehydrate(sql, args.conversationId, [...trace.sourceIds])
    await recordTurnLabels(sql, { ...args, counters: countersOf(trace, priced) })
  } catch (err) {
    console.error(`turn labels not written for ${args.turnId}: ${String(err)}`)
  }
}
