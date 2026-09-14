import type postgres from 'postgres'
import { rememberUserFact } from '../repo/memory.js'

/** One component she asked us to change, and what she said about it. */
export type Revision = { turnId: string; slot: string; instruction: string }

/**
 * Every `revise_component` call in one conversation, out of the transcript.
 *
 * `course.turns.state` and NOT `course.tool_calls`, for the reason
 * `src/evals/trajectory.ts`'s `loadTrace` gives at length: `ledgerRunner` is the
 * only writer of that table, and `scripts/trip.ts` and the eval chain both
 * compose the runner chain without it, so it holds nothing at all for anything
 * but a tier 3 turn. The transcript is written on every path.
 *
 * Ordered by the turn order the conversation produced, never by `created_at`,
 * because every row of one turn shares a transaction timestamp.
 */
export async function revisionsFor(
  sql: postgres.Sql, args: { conversationId: string; userId: string },
): Promise<Revision[]> {
  const rows = await sql<{ id: string; state: { messages?: { role: string; content: unknown[] }[] } | null }[]>`
    select id, state from course.turns
     where conversation_id = ${args.conversationId} and user_id = ${args.userId}
     order by queued_at, id`
  const out: Revision[] = []
  for (const row of rows) {
    for (const message of row.state?.messages ?? []) {
      if (message.role !== 'assistant') continue
      for (const block of message.content as { type?: string; name?: string; input?: unknown }[]) {
        if (block.type !== 'tool_use' || block.name !== 'revise_component') continue
        const input = block.input as { slot?: string; instruction?: string }
        if (typeof input?.slot !== 'string') continue
        out.push({ turnId: row.id, slot: input.slot, instruction: input.instruction ?? '' })
      }
    }
  }
  return out
}

/**
 * What we learned from what she changed, phrased as an observation.
 *
 * "Last time you swapped away from the flight we picked" and never "you prefer
 * short layovers". The first is a thing that happened and she can correct it
 * without arguing. The second is a preference she never stated, defended by a
 * desk that cannot tell the two apart. `course.user_memory.inferred` is the
 * column that keeps them apart and `renderMemory` (src/repo/memory.ts) carries
 * the flag all the way into the request, so the desk reads a marked guess
 * rather than a fact.
 *
 * One fact per SLOT and not per call. She swapped the hotel four times in one
 * conversation because the first three were wrong, and four facts saying so
 * would be one observation counted four times in a prompt that is capped at
 * forty facts.
 */
export function inferredFactsFrom(revisions: readonly Revision[]): string[] {
  const slots = [...new Set(revisions.map((r) => r.slot))]
  return slots.map((slot) =>
    `Last time, she asked us to change the ${slot} we picked, so the first ${slot} we `
    + 'propose may not be the one she wants.')
}

/**
 * Writes those facts, best effort, and returns how many landed.
 *
 * NEVER throws, and the reason is P2's rule for `onUserDecision`: this runs
 * inside the accept path, after `decideProposal` has recorded her answer and
 * before or beside a hand-off she is waiting on, and a memory write that failed
 * is a thing we did not learn rather than a decision she did not make. The one
 * row in this system that is not best effort is the escalation
 * (`escalationRunner`, src/tools.ts), and its docstring says so.
 *
 * `inferred: true` is the CALLER's and never the model's, the same rule
 * `applyRequirementsPatch`'s `source` follows: a model asked to label its own
 * conclusion as something she said has every incentive to.
 */
export async function rememberInferred(
  sql: postgres.Sql, args: { conversationId: string; userId: string },
): Promise<number> {
  try {
    const revisions = await revisionsFor(sql, args)
    const facts = inferredFactsFrom(revisions)
    let written = 0
    for (const fact of facts) {
      await rememberUserFact(sql, {
        userId: args.userId, fact, inferred: true,
        sourceTurn: revisions.find((r) => fact.includes(r.slot))?.turnId ?? null,
      })
      written += 1
    }
    return written
  } catch {
    // Deliberately swallowed and deliberately silent about the traveller: the
    // caller is mid-accept and has nothing to tell her, and a log line carrying
    // her conversation id into stderr is the one thing this path must not do.
    return 0
  }
}
