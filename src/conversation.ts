import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient } from './client.js'
import { loadDesk, renderPrompt } from './desks.js'
import { classify } from './classify.js'
import { exceedsAnyCeiling, type Spend } from './engine.js'
import { extract } from './extract.js'
import { DEFAULT_LIMITS } from './limits.js'
import { limitReachedMessage } from './limit-message.js'
import { addUsage, readSpendOrLimitReached, toolLoop, type LoopResult } from './loop.js'
import { applyRequirements, emptyNotebook, type Notebook } from './notebook.js'
import type { ModelCallSink } from './repo/model-calls.js'
import type { ToolRunner } from './tools.js'
import { toolsForDesk } from './tools/registry.js'

export type Conversation = {
  id: string
  notebook: Notebook
  /** Every reply we sent her, in order; the only record of the conversation there is. */
  replies: string[]
}

export const TODAY = '2026-08-29'

/**
 * The published tool definitions for the two desks `turn()` drives, cast once
 * each to the SDK's `Tool`.
 *
 * `toolsForDesk` (src/tools/registry.ts) returns `unknown[]` on purpose: what
 * goes on the wire is the API's shape and not the shape the installed SDK types
 * describe, which is the same reason `buildRequest` (src/model/client.ts)
 * returns a plain object. `toolLoop` still takes the SDK's array, so the two
 * facts meet in these two casts rather than in five call sites.
 *
 * From lesson 5.2 the planning list holds `update_requirements` and `ask_user`
 * as well. The chain `npm run trip` builds answers the first (`notebookRunner`,
 * src/tools.ts) and not the second: `ask_user` is terminal in the driver
 * (src/agents/driver.ts) and `toolLoop` has no step that ends a turn on a
 * question, so on that path it comes back as an error result. README.md names
 * it; lesson 5.3 puts `npm run trip` on the driver.
 */
const PUBLISHED_FRONT = toolsForDesk('front') as Tool[]
const PUBLISHED_PLANNING = toolsForDesk('planning') as Tool[]

export function newConversation(id = 'conv-1'): Conversation {
  return { id, notebook: emptyNotebook(), replies: [] }
}

export type TurnResult = LoopResult & { conversation: Conversation; desk: 'front' | 'planning' }

/**
 * Everything a caller can tell one turn beyond her message. Fields are added by
 * later lessons (2.5 a recorder, 2.6 a spend reader); the parameter list does
 * not change again.
 */
export type TurnOptions = {
  /** When the process running this turn expects to be killed. */
  deadlineMs?: number
  /** Where every model call this turn makes writes its row. */
  record?: ModelCallSink
  /** Read once per step, so a ceiling check is never stale for the rest of the turn. */
  readSpend?: () => Promise<Spend>
  /** Aborted when this worker is superseded; passed to the model client and the tool runner. */
  signal?: AbortSignal
}

/**
 * One message from her, one reply from us. Extraction writes her words into
 * the notebook before the desk reads it, so the desk plans from what she
 * said across every turn and not only this one. `costMicros` is the sum of
 * every model call this turn made, classify and (on the planning path)
 * extract included, because a bill that only counted the loop would be one
 * she never actually paid.
 */
export async function turn(
  conversation: Conversation,
  text: string,
  client: ModelClient,
  run: ToolRunner,
  options: TurnOptions = {},
): Promise<TurnResult> {
  // Checked before classify, which is the FIRST model call this turn makes,
  // not only before the loop's steps. Without this, the tier-2 comment in
  // handler.ts ("otherwise the refusal arrives one step into the turn, after
  // a model call has already been paid for") was false for exactly the two
  // calls, classify and extract, that toolLoop's own per-step check cannot
  // see because they run before the loop starts. The reply below is the same
  // sentence tier 2 and the loop's own stop branch write (src/limit-message.ts),
  // so a ceiling hit here reads to her the same as either of those.
  //
  // The read goes through readSpendOrLimitReached, the same helper the loop
  // uses for its own per-step read, rather than a bare await: on tier 3 this
  // is the FIRST read of the whole turn, before toolLoop ever runs, so an
  // uncaught fail-closed throw here would escape turn() itself and strand the
  // turn at 'queued' the way run-turn-background.mts's try/finally (no catch)
  // cannot recover from. A throw and a confirmed ceiling hit both end up
  // meaning the same thing: do not prove it is safe to spend more.
  if (options.readSpend) {
    const read = await readSpendOrLimitReached(options.readSpend)
    if (read === 'limit_reached' || exceedsAnyCeiling(read, DEFAULT_LIMITS)) {
      return {
        outcome: 'limit_reached',
        text: limitReachedMessage(read, DEFAULT_LIMITS),
        steps: 0,
        toolTrace: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        costMicros: 0n,
        conversation,
        // Arbitrary: no call was made yet, so no desk was ever chosen. Nothing
        // downstream reads `desk` on this outcome (router.ts's `handle()` never
        // passes `readSpend`, so this branch cannot fire there).
        desk: 'planning',
      }
    }
  }
  const classified = await classify(text, client, options.record)
  if (classified.label === 'faq') {
    const desk = loadDesk('front')
    const result = await toolLoop({
      seat: desk.seat,
      system: renderPrompt(desk, {}),
      userText: text,
      tools: PUBLISHED_FRONT,
      run,
      client,
      deadlineMs: options.deadlineMs,
      promptVersion: desk.promptVersion,
      record: options.record,
      readSpend: options.readSpend,
      signal: options.signal,
    })
    const next = { ...conversation, replies: [...conversation.replies, result.text] }
    return {
      ...result,
      usage: addUsage(result.usage, classified.usage),
      costMicros: result.costMicros + classified.costMicros,
      conversation: next,
      desk: 'front',
    }
  }
  const extracted = await extract(text, client, options.record)
  const patch = Object.fromEntries(Object.entries(extracted.requirements).filter(([, v]) => v !== null))
  // `.next` from lesson 5.2: `applyRequirements` also names the keys it
  // refused, which the `update_requirements` tool answers the model with
  // (`notebookRunner`, src/tools.ts). This path discards that list, because
  // `turn()` has nothing to tell her with. It is not empty in general:
  // `PatchSchema` bounds values `RequirementsSchema` cannot bound, since the
  // API's `output_config.format` rejects numeric keywords (src/extract.ts), so
  // an extracted `nights: 90` or a party of twelve is refused here and refused
  // WHOLESALE, and her destination and budget go with it, with nothing in the
  // log to say so. Lesson 5.3 puts this script on the driver, where the
  // refusal reaches the model as a tool result.
  const { next: notebook } = applyRequirements(
    conversation.notebook, patch, 'user', new Date().toISOString())
  const desk = loadDesk('planning')
  // `{{today}}` and nothing else. The planning prompt lost `{{requirements}}`
  // and `{{dropped}}` at lesson 5.2, when the notebook moved into the request's
  // suffix, and `renderPrompt` ignores a var no slot names, so the two that were
  // left here filled nothing: `notebookForPrompt` was called, `dropped` was
  // joined, and both strings were thrown away. What it costs on THIS path is
  // named in README.md: `turn()` has no suffix to put the notebook in, so the
  // planning desk plans from her message alone until lesson 5.3 puts `npm run
  // trip` on the driver. `extracted.dropped` is still computed by `extract`,
  // which is where the recorded fixtures assert it (test/extract.test.ts); it is
  // simply not something this prompt has anywhere to say.
  const system = renderPrompt(desk, { today: TODAY })
  const result = await toolLoop({
    seat: desk.seat,
    system,
    userText: text,
    tools: PUBLISHED_PLANNING,
    run,
    client,
    deadlineMs: options.deadlineMs,
    promptVersion: desk.promptVersion,
    record: options.record,
    readSpend: options.readSpend,
    signal: options.signal,
  })
  const next = { ...conversation, notebook, replies: [...conversation.replies, result.text] }
  return {
    ...result,
    usage: addUsage(addUsage(result.usage, classified.usage), extracted.usage),
    costMicros: result.costMicros + classified.costMicros + extracted.costMicros,
    conversation: next,
    desk: 'planning',
  }
}
