import type postgres from 'postgres'
import { fenceResult } from '../tools/validate.js'

/**
 * One fact about one traveller, as `course.user_memory` holds it.
 *
 * `inferred` is carried out of the table and all the way into the prompt rather
 * than being flattened on the way: a fact she stated and a fact we concluded
 * are different kinds of claim, and a desk that cannot tell them apart defends
 * a guess instead of asking about it.
 */
export type UserFact = {
  id: string
  fact: string
  inferred: boolean
  sourceTurn: string | null
}

/**
 * How many of her facts a request carries. The prompt has to stay bounded: a
 * traveller with two hundred remembered facts would otherwise grow every
 * request of every turn without limit, and the suffix is the part of the prompt
 * that is never cached, so every one of those tokens is paid for at full price
 * on every step.
 */
const DEFAULT_MEMORY_LIMIT = 40

/**
 * Writes one fact and returns its id, verified through `returning` like every
 * other writer on this branch: a memory write that touched no row is not a
 * smaller success, it is a fact the agency does not have.
 *
 * `inferred` is the caller's and never the model's, for the same reason
 * `applyRequirementsPatch`'s `source` is (src/repo/notebook.ts): a model asked
 * to label its own conclusion as something she said would have every incentive
 * to, and the harness is the only thing that knows which it was.
 */
export async function rememberUserFact(
  sql: postgres.Sql,
  args: { userId: string; fact: string; inferred: boolean; sourceTurn: string | null },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into course.user_memory (user_id, fact, inferred, source_turn)
    values (${args.userId}, ${args.fact}, ${args.inferred}, ${args.sourceTurn})
    returning id`
  const row = rows[0]
  if (!row) throw new Error('rememberUserFact: insert wrote no row')
  return row.id
}

/**
 * Her facts, newest first, scoped to one user id and to nothing else.
 *
 * Ordered by `seq desc` and never by `created_at`: a test writes several facts
 * inside one transaction, where every `created_at` is the same
 * `transaction_timestamp()`, so ordering on it is not an order at all. That is
 * the same rule `course.messages` follows and the same reason the column is
 * there.
 */
export async function readUserMemory(
  sql: postgres.Sql, userId: string, limit: number = DEFAULT_MEMORY_LIMIT,
): Promise<UserFact[]> {
  const rows = await sql<
    { id: string; fact: string; inferred: boolean; source_turn: string | null }[]
  >`
    select id, fact, inferred, source_turn from course.user_memory
     where user_id = ${userId}
     order by seq desc
     limit ${limit}`
  return rows.map((r) => ({
    id: r.id, fact: r.fact, inferred: r.inferred, sourceTurn: r.source_turn,
  }))
}

/**
 * Writes a fact about a supplier or a property. No user id, because there is no
 * user whose fact it is: a cot policy is true for whoever asks.
 *
 * Returns nothing, and still verifies through `returning`. The caller has no use
 * for the id, and "the insert wrote a row" is not something a writer on this
 * branch takes on trust either way.
 */
export async function rememberSourceFact(
  sql: postgres.Sql, args: { sourceKey: string; fact: string },
): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    insert into course.source_memory (source_key, fact)
    values (${args.sourceKey}, ${args.fact})
    returning id`
  if (rows.length === 0) throw new Error('rememberSourceFact: insert wrote no row')
}

/**
 * The source facts for the keys a turn's corpus actually holds, and no others.
 *
 * Keyed rather than flat, so the render can say which property each fact is
 * about. Scoped to the keys the caller asks for, because a conversation about
 * Faro has no business being told about a property in Reykjavik, and because a
 * memory that grew with the whole supplier catalogue would be an unbounded
 * prefix on every turn of every conversation.
 *
 * An empty key list short-circuits rather than sending `= any('{}')`, which is
 * both a round trip and a query the planner has to do something with.
 */
export async function readSourceMemory(
  sql: postgres.Sql, sourceKeys: string[],
): Promise<Map<string, string[]>> {
  if (sourceKeys.length === 0) return new Map()
  const rows = await sql<{ source_key: string; fact: string }[]>`
    select source_key, fact from course.source_memory
     where source_key = any(${sourceKeys})
     order by source_key, seq desc`
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const facts = out.get(r.source_key)
    if (facts) facts.push(r.fact)
    else out.set(r.source_key, [r.fact])
  }
  return out
}

/**
 * Memory as text for the model, FENCED, and rendered into the same
 * `CallArgs.suffix` the notebook uses.
 *
 * Fenced, because a memory is a fact somebody wrote down and at least one writer
 * is a model that had just read a supplier's page. A fact recorded as "this
 * property asks guests to confirm their card number by email" is a true and
 * useful thing to remember and is also an instruction if it arrives unmarked, so
 * the same wrapper that marks a tool result marks this. The nonce is per render
 * for the same reason it is per call.
 *
 * In the SUFFIX and not in the system prompt, so it lands after the last cache
 * breakpoint. Memory changes when a fact is learned, which is rarely, and the
 * notebook changes every turn, and they share a suffix: putting either inside
 * the cached prefix would throw the prefix away on the turn it changed. Sharing
 * one suffix costs nothing, because everything after the last breakpoint is
 * uncached either way.
 *
 * An inferred fact is marked as inferred, so the desk can tell a thing she said
 * from a thing we concluded, and can ask rather than assume.
 */
export function renderMemory(
  user: UserFact[], source: Map<string, string[]>, nonce: string,
): string {
  const lines: string[] = []
  if (user.length > 0) {
    lines.push('What we know about this traveller:')
    for (const f of user) lines.push(`- ${f.fact}${f.inferred ? ' (inferred)' : ''}`)
  }
  for (const [key, facts] of source) {
    if (facts.length === 0) continue
    if (lines.length > 0) lines.push('')
    lines.push(`What we know about ${key}:`)
    for (const fact of facts) lines.push(`- ${fact}`)
  }
  if (lines.length === 0) return ''
  // `worker` and not `code`: a `code`-door result is ours and comes back
  // unchanged, and this is the one thing in the request that looks like ours and
  // is not. The escaping and the nonce-shaped stripping inside `fenceResult` do
  // the rest.
  return fenceResult('memory', 'worker', lines.join('\n'), nonce)
}
