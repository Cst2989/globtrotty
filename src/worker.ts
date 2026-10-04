import type postgres from 'postgres'
import {
  decideNext,
  type Limits, type TurnState, type LoopMessage, type ContentBlock, type FailReason,
} from './engine.js'
import {
  claimTurn, saveTurnState, completeTurn, failTurn, heartbeat, releaseForContinuation,
  FencedError, type Claim,
} from './repo/turns.js'
import { classifyError } from './errors.js'
import { recordSpend, readSpendFailClosed } from './repo/spend.js'
import { beginToolCall, finishToolCall } from './repo/toolCalls.js'
import { parseAction, renderActionMessage } from './actions.js'
import {
  parseResults, parseChoices, renderResultsNote, renderChoicesNote,
  ResultsContentSchema, ChoicesContentSchema,
  type ResultsContent, type ChoicesContent,
} from './results.js'
import { screenOutbound, SCREENED_REPLY } from './sanitize.js'
import { recordAgentEvent } from './repo/agentEvents.js'
import { recordEscalation, markNotified } from './repo/escalations.js'
import type { Notifier } from './notify.js'

export type AgentContext = {
  state: TurnState
  conversationId: string
  userId: string
  /**
   * The turn this step belongs to. Everything durable an agent does — the
   * per-turn supplier budget, the model_calls ledger, gate_results, tool_results
   * — is scoped to a turn, and an agent that cannot name its turn can write none
   * of it.
   */
  turnId: string
}

export type AgentStep =
  | {
      kind: 'message'; text: string; costMicros: bigint
      /**
       * Plan 5: a `results` or `choices` row (src/results.ts) written right
       * after this step's `message` row, in `created_at` order — so a
       * results card or a question card follows the agent's own prose rather
       * than preceding it. `loop()` validates each `content` against its zod
       * schema before writing (`ResultsContentSchema` / `ChoicesContentSchema`)
       * and throws on a schema failure: only our own code builds these, so a
       * failure here is a bug in that code, never traveller or supplier input
       * to tolerate.
       */
      attachments?: { role: 'results' | 'choices'; content: ResultsContent | ChoicesContent }[]
      /**
       * Spend the AGENT has already debited (src/repo/reservation.ts, Task 4).
       *
       * `loop()` adds this to the turn total so `turns.spend_usd_micros` reports
       * what the turn really cost — but it does NOT pass it to `recordSpend`,
       * which would apply the identical `conversations.spend_usd_micros`
       * increment and `daily_usage` UTC upsert a SECOND time. Spec section 8
       * requires the agent to reserve before dispatch, so the agent owns that
       * ledger; the worker's job is to believe it.
       *
       * `costMicros` keeps its original meaning: spend nobody has debited yet,
       * which the worker debits on the agent's behalf.
       *
       * THE RULE IS ABOUT MICROS, NOT ABOUT FIELDS: the same micros must never
       * be named in both. Setting both fields is legitimate and expected — a
       * `tool` step whose model call was self-debited and whose supplier call
       * the worker still owes are two different sets of micros on one step.
       * `loop()` charges each field through its own door exactly once, so both
       * being present is safe; naming one amount twice is not, because
       * `recordSpend` would apply it to `conversations.spend_usd_micros` and
       * `daily_usage` on top of the debit the agent already made.
       */
      recordedMicros?: bigint
    }
  /**
   * "Call me again": the agent did work that ends no turn and adds nothing to
   * the transcript — the front desk routing a conversation to planning. The
   * step counter still advances so a misbehaving agent cannot loop forever
   * under maxSteps. `recordedMicros` follows the same rule as everywhere else:
   * already debited, folded into the turn total, never passed to recordSpend.
   */
  | { kind: 'continue'; costMicros: bigint; recordedMicros?: bigint }
  /**
   * Ends the turn in a NAMED failure, with words she can act on. Spec section 8:
   * a refused driver call "fails the turn with words she can act on and does not
   * consume quota" — parking would record status 'done' with fail_reason null,
   * which makes a refusal indistinguishable from a normal question and leaves
   * `refused` (src/engine.ts) with no writer anywhere in the codebase.
   *
   * No `costMicros`: by construction the only agent that fails a turn is one
   * that already made (and debited) the call that failed, so what it spent
   * belongs in `recordedMicros`.
   */
  | {
      kind: 'fail'; reason: FailReason; message: string
      /** Already debited by the agent — see the `message` variant above. */
      recordedMicros?: bigint
    }
  /**
   * Terminal for the turn, but not a failure: she has been asked something and
   * the conversation is waiting on her. Spec section 4 makes it a terminal turn
   * status (`done`) with the conversation `awaiting_user`, precisely so the
   * sweeper cannot resurrect it and re-bill a model call for a conversation that
   * is simply idle.
   *
   * Carries `message`, not `text`, so it cannot be routed through the message
   * branch by accident: a question and an answer are not the same event, even
   * though both end the turn.
   */
  | {
      kind: 'park'; message: string; costMicros: bigint; recordedMicros?: bigint
      /** Same contract as the `message` arm's `attachments` above. */
      attachments?: { role: 'results' | 'choices'; content: ResultsContent | ChoicesContent }[]
    }
  | {
      kind: 'tool'; callId: string; name: string
      run: () => Promise<unknown>
      costMicros: bigint
      /** Already debited by the agent — see the `message` variant above. */
      recordedMicros?: bigint
      /**
       * The assistant turn that ASKED for this tool, verbatim — the `thinking`
       * and `tool_use` blocks exactly as the provider returned them. `loop()`
       * appends it ahead of the tool result. Without it the transcript grows a
       * `tool_result` with no matching `tool_use`, which is a 400 on the next
       * request; and a re-sent `thinking` block that was not echoed back
       * byte-for-byte is rejected as well. Optional so `echoAgent` and the demo
       * agent, which have no assistant turn to echo, are unaffected.
       */
      assistantContent?: ContentBlock[]
      /**
       * Micros the tool debited ITSELF during run() — a reviewer call inside
       * propose_itinerary. Folded into the turn total in a `finally` wrapped
       * around `run()`, so a throw after a self-debited call still reaches
       * the turn total — exactly the property the `alreadyDebited` comment in
       * `loop()` argues for, applied to a debit that isn't known until run()
       * resolves (or throws). Never passed to recordSpend.
       */
      spent?: { micros: bigint }
    }

export type Agent = (ctx: AgentContext) => Promise<AgentStep>

export type WorkerDeps = {
  sql: postgres.Sql
  limits: Limits
  agent: Agent
  now: () => number
  deadlineMs: () => number
  reinvoke: (turnId: string) => Promise<void>
  /**
   * The human desk's inbox. Required, not optional — `screenReply` (below)
   * pages a human on every screened reply, and a worker with no way to do
   * that is a worker that silently drops a safety event rather than one
   * that fails loudly at construction time, before any turn runs.
   */
  notifier: Notifier
  /**
   * How often to emit a liveness heartbeat while a step is in flight. Defaults to
   * HEARTBEAT_INTERVAL_MS. Tests override this to something short so the behavior
   * can be observed without a real multi-second wait.
   */
  heartbeatIntervalMs?: number
}

const EST_STEP_MS = 60_000
// Well under HEARTBEAT_STALE (90s, src/repo/turns.ts) so a real step — a dozen
// model calls, parallel workers, a 60s Retry-After sleep — keeps refreshing
// heartbeat_at faster than the sweeper's staleness window can close on it.
const HEARTBEAT_INTERVAL_MS = 25_000
const EMPTY: TurnState = { step: 0, messages: [] }

/** Proves the harness without a model: echoes the last user message back. */
export const echoAgent: Agent = async ({ state }) => {
  const last = [...state.messages].reverse().find((m) => m.role === 'user')
  const text = last?.content.find((b) => b.type === 'text')
  return {
    kind: 'message',
    text: `You said: ${text?.type === 'text' ? text.text : '(nothing)'}`,
    costMicros: 1_000n,
  }
}

export async function runTurn(deps: WorkerDeps, turnId: string): Promise<void> {
  const { sql } = deps
  const claim = await claimTurn(sql, turnId)
  if (!claim) return                       // another worker owns it; walk away silently

  // Accumulated across every step of this run, so whichever exit path fires —
  // completeTurn, failTurn on a decideNext stop, or the crash handler below —
  // records what this turn actually spent instead of always writing 0.
  const turnSpend = { total: 0n }

  try {
    await loop(deps, claim, turnSpend)
  } catch (err) {
    if (err instanceof FencedError) return // superseded: write nothing
    // FencedError above returns FIRST and is never classified: a superseded worker
    // must write nothing at all, and stamping a fail_reason on a turn it no longer
    // owns would overwrite the run that took it over.
    //
    // Everything else is classified rather than blanket-recorded as 'provider_down'
    // (plan 1's accepted limitation, now removed). Only `reason` is used, and that
    // is not a signal being withheld from anything: THERE IS NO RETRY MECHANISM TO
    // FEED. failTurn sets status = 'failed', and the sweeper only ever considers
    // 'queued' or 'running' rows — so every failure below is terminal, and
    // `retryable: true` from the classifier would not mean the turn was retried.
    // Nothing here has changed about that; the classifier changed what the row
    // SAYS, not what happens to it.
    //
    // That terminality is also, by construction, the guard the brief asks for: a
    // 'failed' turn matches neither arm of `status in ('queued','running')`, so a
    // non-retryable failure cannot be requeued until the sweeper reaps it as a
    // crash loop, however stale its heartbeat gets. Pinned by test/worker.test.ts.
    //
    // Plan 3 brought the model client and `retryable` still has zero production
    // consumers: the SDK's own `maxRetries` (default 2) already retries 429s and
    // 5xx beneath us before an error reaches `classifyError` here. What is left
    // unbuilt is turn-level retry — whoever decides, deliberately, whether a
    // transient failure should ever be requeued instead of failed. Branching on
    // `retryable` here would be inventing that semantics with nothing to justify
    // its shape.
    //
    // The assignment below is also the compile-time check that every
    // ClassifiedReason (src/errors.ts) is a real FailReason (src/engine.ts) --
    // errors.ts deliberately does not import the engine, so this is where the two
    // unions are proven to agree.
    const { reason } = classifyError(err)
    await failTurn(sql, claim, reason, turnSpend.total).catch(() => {})
    throw err
  }
}

/**
 * Runs `work` while periodically calling heartbeat(sql, claim), so a step that
 * runs long (a dozen model calls, parallel workers, a 60s Retry-After sleep)
 * keeps advancing heartbeat_at and is never mistaken by the sweeper for a dead
 * worker mid-call. If a tick discovers we've been superseded (FencedError), the
 * error is captured and re-thrown once `work` settles — the loop aborts rather
 * than continuing to act on a turn it no longer owns. Any other heartbeat
 * failure is treated as transient and swallowed (the next tick retries), so a
 * tick can never surface as an unhandled rejection.
 */
async function withHeartbeat<T>(
  sql: postgres.Sql, claim: Claim, intervalMs: number, work: () => Promise<T>,
): Promise<T> {
  let fenced: FencedError | null = null
  const timer = setInterval(() => {
    heartbeat(sql, claim).catch((err: unknown) => {
      if (err instanceof FencedError) fenced = err
    })
  }, intervalMs)
  try {
    const result = await work()
    if (fenced) throw fenced
    return result
  } finally {
    clearInterval(timer)
  }
}

type MessageRow = { role: 'user' | 'agent' | 'action' | 'results' | 'choices'; content: string }

/**
 * Said when an `action` row's `content` fails `parseAction` — a garbled
 * write, not something a card the UI actually renders could produce. Never
 * thrown: an unreadable action still has to become SOME message so the turn
 * can proceed, and it must never fall back to a `user` role, which would let
 * an unparseable row read as her own words rather than as the office's.
 */
const UNREADABLE_ACTION_TEXT =
  'Operator: a card action was recorded but could not be read. Ask her what she would like to do.'

/**
 * The outbound side of the sanitize boundary: every agent reply passes
 * through `screenOutbound` (src/sanitize.ts) here, in the ONE place both
 * `case 'message'` and `case 'park'` reach on their way to a stored message.
 * A hit replaces `text` with `SCREENED_REPLY`, records why, and pages a
 * human.
 *
 * `recordAgentEvent` is best-effort and swallowed — the audit row is a
 * nice-to-have alongside the escalation, never something that blocks it.
 * `recordEscalation` is NOT swallowed: it is called directly rather than
 * through the `escalate_to_human` tool (a filter firing on the office's OWN
 * words is not a model choosing to escalate, so the tool's per-user daily
 * limit must not gate it — controller ruling: a screened reply always
 * pages), and its row is the one thing this function cannot proceed without
 * — there is no `e: Escalation` to hand the notifier otherwise. From there
 * the notifier call follows `escalate.ts`'s own pattern exactly: `notify`
 * is best-effort and swallowed, and `markNotified` runs only when `notify`
 * actually succeeded, also best-effort. A screened reply must still reach
 * her, and the turn must still finish, even if the page itself fails to
 * send or to stamp.
 */
/**
 * Validates and serializes a `message`/`park` step's `attachments` into the
 * row shape `completeTurn` writes. Each `content` is validated against its
 * own zod schema (`ResultsContentSchema` / `ChoicesContentSchema`,
 * src/results.ts) BEFORE it is stringified — `.parse` (not `.safeParse`), so
 * a schema failure throws rather than silently writing a row nothing can
 * read back: only our own code builds an `AgentStep.attachments` entry, so a
 * failure here is a bug in that code, never traveller- or supplier-origin
 * input to tolerate.
 */
function buildAttachmentRows(
  attachments: { role: 'results' | 'choices'; content: ResultsContent | ChoicesContent }[] | undefined,
): { role: 'results' | 'choices'; content: string }[] {
  if (!attachments) return []
  return attachments.map((a) => {
    if (a.role === 'results') {
      ResultsContentSchema.parse(a.content)
    } else {
      ChoicesContentSchema.parse(a.content)
    }
    return { role: a.role, content: JSON.stringify(a.content) }
  })
}

async function screenReply(
  sql: postgres.Sql, notifier: Notifier, claim: Claim, text: string,
): Promise<string> {
  const s = screenOutbound(text)
  if (s.ok) return text

  await recordAgentEvent(sql, {
    conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
    kind: 'screened', payload: { reason: s.reason, original: text.slice(0, 4000) },
  }).catch((err: unknown) => {
    console.error(`worker: recordAgentEvent for screened reply failed: ${(err as Error).message}`)
  })

  const e = await recordEscalation(sql, {
    conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
    proposalId: null, reason: 'safety',
  })

  let notified = false
  try {
    await notifier.notify(e)
    notified = true
  } catch (err) {
    console.error(`worker: notifier failed for screened escalation ${e.id}: ${(err as Error).message}`)
  }
  if (notified) {
    await markNotified(sql, e.id).catch((err: unknown) => {
      console.error(`worker: notified_at stamp failed for ${e.id}: ${(err as Error).message}`)
    })
  }

  return SCREENED_REPLY
}

async function loop(
  deps: WorkerDeps, claim: Claim, turnSpend: { total: bigint },
): Promise<void> {
  const { sql, limits } = deps
  let state: TurnState = claim.state ?? { ...EMPTY }

  if (state.messages.length === 0) {
    const rows = await sql<MessageRow[]>`
      select role, content from messages
       where conversation_id = ${claim.conversationId} order by created_at`
    state = {
      ...state,
      messages: rows.map((r): LoopMessage => {
        // 'action' hydrates as the operator channel (src/engine.ts's
        // LoopMessage doc comment) — a `system` message, never `user`: a
        // button press is not her typed text, and treating it as one would
        // let it be forged by typing the same JSON into the chat box.
        if (r.role === 'action') {
          const parsed = parseAction(r.content)
          return {
            role: 'system',
            content: [{ type: 'text', text: parsed ? renderActionMessage(parsed) : UNREADABLE_ACTION_TEXT }],
          }
        }
        // Plan 5: `results` and `choices` rows (src/results.ts) hydrate the
        // same way `action` does — a `system` message via their own
        // renderer, falling back to the same unreadable-row text on a parse
        // failure (a garbled write, never something our own writer produces).
        if (r.role === 'results') {
          const parsed = parseResults(r.content)
          return {
            role: 'system',
            content: [{ type: 'text', text: parsed ? renderResultsNote(parsed) : UNREADABLE_ACTION_TEXT }],
          }
        }
        if (r.role === 'choices') {
          const parsed = parseChoices(r.content)
          return {
            role: 'system',
            content: [{ type: 'text', text: parsed ? renderChoicesNote(parsed) : UNREADABLE_ACTION_TEXT }],
          }
        }
        return {
          role: r.role === 'agent' ? 'assistant' : 'user',
          content: [{ type: 'text', text: r.content }],
        }
      }),
    }
  }

  for (;;) {
    const spend = await readSpendFailClosed(sql, claim.userId, claim.conversationId)
    const decision = decideNext({
      state, spend, limits,
      nowMs: deps.now(), deadlineMs: deps.deadlineMs(), estStepMs: EST_STEP_MS,
      pendingUserMessage: null,
    })

    switch (decision.kind) {
      case 'stop':
        await failTurn(sql, claim, decision.reason, turnSpend.total)
        return
      case 'continue_later':
        // Persist state AND release ownership (status -> 'queued') in one statement,
        // THEN schedule — see releaseForContinuation's doc comment. Using
        // saveTurnState here would leave the turn 'running' with a fresh
        // heartbeat_at, so the re-invocation's own claimTurn could never claim it.
        //
        // F5: the run's accumulated spend goes with it, into
        // turns.spend_usd_micros, exactly like every other exit path — and
        // turnSpend.total is reset to 0n immediately after: the re-invocation
        // this triggers is a fresh runTurn call whose own turnSpend starts at
        // 0n, so this process must never add the same micros again (nothing
        // reads turnSpend after this branch returns, but zeroing it here keeps
        // the invariant visible rather than relying on that).
        await releaseForContinuation(sql, claim, state, turnSpend.total)
        turnSpend.total = 0n
        await deps.reinvoke(claim.turnId)
        return
      case 'park':
        // NOT the same gap as the AgentStep 'park' below, which is now
        // implemented and is the path `offer_choices` uses. decideNext returns this
        // only for a PENDING USER MESSAGE that needs answering mid-turn, which
        // nothing in this plan wires. Kept as a throw rather than a silent
        // fall-through so the plan that wires it must replace real behaviour
        // rather than find it accidentally "working".
        throw new Error(`worker: 'park' decision is not implemented (message: ${decision.message})`)
      case 'call_model':
        break // fall through to invoking the agent below
      default: {
        // Exhaustiveness guard for any FUTURE Decision variant: the compiler
        // rejects this file the moment engine.ts grows a kind not listed above.
        const unhandled: never = decision
        throw new Error(`worker: unhandled decision kind ${JSON.stringify(unhandled)}`)
      }
    }

    const step = await withHeartbeat(
      sql, claim, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      () => deps.agent({
        state, conversationId: claim.conversationId,
        userId: claim.userId, turnId: claim.turnId,
      }),
    )

    // Written as an explicit comparison rather than `?? 0n` so the zero is
    // visibly a confirmed reading — "this agent debited nothing" — and not a
    // default standing in for a value we failed to obtain. Same rule as
    // readSpendFailClosed; this file sits outside src/repo/**, where the lint
    // rule enforces it, so the discipline has to be deliberate here.
    const alreadyDebited = step.recordedMicros === undefined ? 0n : step.recordedMicros

    // Added BEFORE the switch, not inside each branch. The agent's own debit is
    // an accomplished fact the moment the step is in our hands: it has already
    // hit conversations.spend_usd_micros and daily_usage. Adding it later — after
    // the tool path's heartbeat and beginToolCall, as this first did — means a
    // database error in either await sends control to runTurn's catch, and the
    // failTurn there records a turn total missing the agent's spend. No money is
    // lost that way, but the turn row under-reports what the turn cost, which is
    // the one number a human reads to find out. Every path below now inherits it
    // uniformly, including the ones that never reach a happy ending.
    //
    // It is added to the turn total and NEVER passed to recordSpend, on any
    // branch: that is the whole of the no-double-charge invariant, visible here
    // rather than spread across three branches.
    turnSpend.total += alreadyDebited

    switch (step.kind) {
      case 'message': {
        // heartbeat() as a cheap ownership assertion: recordSpend and completeTurn
        // don't carry the `attempts` fencing token themselves (they take bare ids),
        // so this fenced single-row update stands in for them — if we've been
        // superseded it throws FencedError here, before any money is spent.
        await heartbeat(sql, claim)
        await recordSpend(sql, {
          userId: claim.userId, conversationId: claim.conversationId,
          costMicros: step.costMicros,
        })
        turnSpend.total += step.costMicros
        await completeTurn(sql, claim, {
          state, agentMessage: await screenReply(sql, deps.notifier, claim, step.text),
          parked: true, spendMicros: turnSpend.total,
          attachments: buildAttachmentRows(step.attachments),
        })
        return
      }
      case 'park': {
        // Same ownership assertion as the message path: recordSpend and
        // completeTurn take bare ids and carry no fencing token of their own.
        await heartbeat(sql, claim)
        await recordSpend(sql, {
          userId: claim.userId, conversationId: claim.conversationId,
          costMicros: step.costMicros,
        })
        turnSpend.total += step.costMicros
        // `parked: true` moves the conversation to 'awaiting_user' — unless
        // `screenReply` just escalated it, in which case `completeTurn`'s own
        // sticky guard keeps it 'escalated'. fail_reason stays null: parking
        // is not a failure, and recording it as one would make "how often
        // does the driver actually fail?" unanswerable.
        await completeTurn(sql, claim, {
          state,
          // Polish pass, section 8: an EMPTY park message means say nothing. A refresh of the
          // flights list while she is choosing a hotel has a row to land and no business
          // interrupting the conversation to announce it, and the alternative the author saw —
          // "Prices refreshed." under a list of hotels, with flight chips — is the office
          // narrating its own bookkeeping. The attachments still land; `completeTurn` writes
          // them with or without a message.
          agentMessage: step.message === ''
            ? null
            : await screenReply(sql, deps.notifier, claim, step.message),
          parked: true, spendMicros: turnSpend.total,
          attachments: buildAttachmentRows(step.attachments),
        })
        return
      }
      case 'fail': {
        // No recordSpend: a failing step's cost, if any, is already debited.
        // The message goes in with failTurn, inside its fenced transaction, so
        // a failed turn is never a blank thread — spec section 8's "words she
        // can act on".
        await heartbeat(sql, claim)
        await failTurn(sql, claim, step.reason, turnSpend.total, step.message)
        return
      }
      case 'continue': {
        await heartbeat(sql, claim)
        await recordSpend(sql, {
          userId: claim.userId, conversationId: claim.conversationId,
          costMicros: step.costMicros,
        })
        turnSpend.total += step.costMicros
        state = { ...state, step: state.step + 1 }
        await saveTurnState(sql, claim, state)
        continue
      }
      case 'tool':
        break // fall through to the tool handling below
      default: {
        // Exhaustiveness guard for any FUTURE AgentStep variant. Without it a
        // new kind silently lands in the tool branch and dereferences
        // step.callId — which is how Task 9's `park` variant would have written
        // a tool_calls row with a null call_id instead of failing to compile.
        const unhandled: never = step
        throw new Error(`worker: unhandled agent step ${JSON.stringify(unhandled)}`)
      }
    }

    // Same ownership assertion ahead of beginToolCall — a superseded worker must
    // not be the one deciding whether this tool call is fresh.
    await heartbeat(sql, claim)
    const outcome = await beginToolCall(sql, claim.turnId, step.callId, step.name)
    let result: unknown
    if (outcome.status === 'replayed') {
      result = outcome.result
    } else if (outcome.status === 'ambiguous') {
      // The previous attempt died mid-side-effect. We cannot know whether it ran
      // (e.g. an email already sent), so we escalate rather than guess either way.
      await failTurn(sql, claim, 'fenced', turnSpend.total)
      return
    } else {
      // Wrapped exactly like deps.agent(...) above: a real supplier call (plan 3)
      // can run past HEARTBEAT_STALE, so heartbeat_at must keep advancing while
      // it's in flight, not just before and after.
      //
      // The `finally` is F4: step.spent.micros is debited by run() ITSELF,
      // partway through — if run() throws after that debit (the reviewer call
      // inside propose_itinerary succeeded, then something later in the same
      // run() failed), the money is already spent and must still land on
      // turns.spend_usd_micros. Folding it only after a successful
      // finishToolCall, as this used to, drops it silently on exactly that path.
      try {
        result = await withHeartbeat(
          sql, claim, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
          () => step.run(),
        )
      } finally {
        if (step.spent !== undefined) turnSpend.total += step.spent.micros
      }
      // ...and ahead of finishToolCall — a superseded worker must not be the one
      // recording this tool call's result as authoritative.
      await heartbeat(sql, claim)
      await finishToolCall(sql, claim.turnId, step.callId, result)
      await heartbeat(sql, claim)
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
      turnSpend.total += step.costMicros
    }

    // A tool result that is already a string is appended verbatim. Task 10's
    // driver returns fenced, trimmed TEXT from run(), and JSON.stringify-ing it
    // would deliver the model an escaped string literal instead of the fence.
    const toolResult: ContentBlock = {
      type: 'tool_result',
      tool_use_id: step.callId,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    }
    state = {
      ...state,
      step: state.step + 1,
      messages: [
        ...state.messages,
        // The assistant turn that asked for the tool, when the agent supplied
        // it. A tool_result with no matching tool_use is a 400.
        ...(step.assistantContent
          ? [{ role: 'assistant' as const, content: step.assistantContent }]
          : []),
        { role: 'user' as const, content: [toolResult] },
      ],
    }
    await saveTurnState(sql, claim, state)
  }
}
