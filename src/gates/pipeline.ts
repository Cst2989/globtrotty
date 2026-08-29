import type postgres from 'postgres'
import { ProposalRefsSchema, rehydrateRefs } from './rehydrateGate.js'
import { checkFreshness, checkSlots, checkTotals, checkBudget, checkDates } from './checks.js'
import { recordGateResults, type GateResultRow } from '../repo/gateResults.js'
import type { Money } from '../money.js'
import type { GateName, GateOutcome, RehydratedItem, Violation } from './types.js'

export type { NotebookConstraints } from './notebookConstraints.js'
export { constraintsFromNotebook } from './notebookConstraints.js'
import type { NotebookConstraints } from './notebookConstraints.js'

/**
 * Every gate this function runs, in the order it runs them. The list is
 * explicit rather than derived from the violations, because a gate that
 * produced no violation still has to write a row — deriving the row set from
 * the fault set is precisely how a gate stops being auditable.
 *
 * 'reviewer' is deliberately absent: it needs a model and arrives in plan 3.
 * `gate_results.gate` already accepts the value, so the seam costs nothing.
 */
const RAN_GATES: readonly GateName[] = [
  'provenance', 'freshness', 'slots', 'currency', 'totals', 'budget', 'dates',
]

/**
 * The back-office gate, in the spec's order.
 *
 * The guarantee: no price the model wrote reaches the user. The model proposes
 * only `{sourceId, quantity, slot}` — there is no price field to tamper with —
 * and every field of every item is read back out of the `tool_results` corpus.
 *
 * Provenance runs FIRST and short-circuits: there is nothing to check the
 * freshness, currency, slot or dates of if the item does not exist. Everything
 * after it runs to completion even once one has failed, so the model gets every
 * problem in a single reply — one violation per round trip would turn a
 * three-fault proposal into three model calls.
 *
 * ## Which gates are called, and which are merely REPORTED
 *
 * `checkCurrency` is NOT called here. `checkTotals` already delegates to it and
 * returns its `currency`-tagged violations, so calling it again would describe
 * one mixed-currency proposal twice, in two sentences, to a model that now has
 * to guess whether it has one problem or two. `Violation.gate` names the FAULT
 * CLASS, not the function that noticed it, so the rows below are bucketed by
 * `v.gate` across the WHOLE violation list rather than by which call produced
 * which array.
 *
 * ## Never throws
 *
 * Every check returns violations. The throwing calls underneath (`sumMoney` on
 * an empty list, `addMoney`/`compareMoney` on a currency mismatch, `itemTotal`
 * on a fractional quantity) are guarded inside the checks themselves. What can
 * still throw is the database write, which is a real failure of the turn and
 * must not be swallowed.
 */
export async function runGates(
  sql: postgres.Sql,
  args: {
    conversationId: string
    turnId: string | null
    refs: unknown
    notebook: NotebookConstraints
    now: Date
    proposalId?: string | null
    round?: number
  },
): Promise<GateOutcome> {
  const round = args.round ?? 0
  const proposalId = args.proposalId ?? null
  const write = (results: GateResultRow[]) =>
    recordGateResults(sql, {
      conversationId: args.conversationId, turnId: args.turnId, proposalId, round, results,
    })

  // The schema is the first gate. A payload carrying a price never reaches the
  // database at all — there is no value here to validate, only references.
  // `rehydrateRefs` re-applies this same schema internally, so the check is not
  // skippable; parsing here as well is what lets a structural fault be recorded
  // and answered without a database round trip.
  const parsed = ProposalRefsSchema.safeParse({ refs: args.refs })
  if (!parsed.success) {
    const detail = `The proposal must reference search results and nothing else `
                 + `({sourceId, quantity, slot}). Rejected: `
                 + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    // A structural fault names no source id: there is no validated id to name.
    const violations: Violation[] = [{ gate: 'provenance', sourceIds: [], detail }]
    await write([{ gate: 'provenance', passed: false, detail, sourceIds: [] }])
    return { ok: false, violations }
  }

  const hydrated = await rehydrateRefs(sql, args.conversationId, parsed.data.refs)
  if (!hydrated.ok) {
    // Bucketed the same way as the full run below, for the same reason: the
    // gate name on the violation is what decides the row, never the call site.
    await write(rowsFor(['provenance'], hydrated.violations, null, null))
    return { ok: false, violations: hydrated.violations }
  }
  const items = hydrated.items

  const totals = checkTotals(items, args.notebook.currency)
  const violations: Violation[] = [
    ...checkFreshness(items, args.now),
    ...checkSlots(items),
    ...totals.violations,                                   // includes the currency check
    ...checkBudget(items, totals, args.notebook.budget),
    ...checkDates(items, args.notebook.window),
  ]

  // `checkTotals` returns `total === null` only for an empty set (the schema
  // requires >= 1 ref, so it cannot happen here) or alongside a violation of its
  // own. The guard exists so that a future change to `checkTotals` cannot make
  // this function return `ok: false` with nothing to tell the model, or reach
  // the non-null assertion below with a null.
  if (totals.total === null && violations.length === 0) {
    violations.push({
      gate: 'totals',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: 'These items could not be totalled. Re-search them and propose the new ids.',
    })
  }

  await write(rowsFor(RAN_GATES, violations, items, totals.total))

  if (violations.length > 0) return { ok: false, violations }
  return { ok: true, items, total: totals.total! }
}

/**
 * One row per gate that RAN, bucketed by `Violation.gate`.
 *
 * ## The `not_evaluated` rule
 *
 * When `total === null` the set could not be summed, and BOTH `totals` and
 * `budget` are recorded `passed = null` — never `true`. The discriminator is
 * `total`, not the violation list, because the violation list does not
 * partition by gate the way bucketing assumes: a mixed-currency proposal
 * returns `{violations: [<currency>], total: null}` — ZERO violations tagged
 * `totals` — and `checkBudget` correctly returns `[]` because there is no
 * number to compare. Bucketing alone would therefore record
 * `currency: fail, totals: pass, budget: pass`, an audit record asserting that
 * a trip total was computed and checked when none exists, from the one gate
 * whose whole job was to refuse to compute it.
 *
 * That rule is applied unconditionally on `total === null`, including when
 * `checkTotals` filed a `totals`-tagged violation of its own (mixed price
 * bases, a bad quantity). The reason is that the totals gate's verdict IS the
 * total: it never produces a total it then disapproves of, so `passed = false`
 * would be a state it cannot reach, and `passed = null` says the accurate
 * thing — no trip total exists — while `detail` still records exactly why.
 */
function rowsFor(
  gates: readonly GateName[],
  violations: readonly Violation[],
  items: RehydratedItem[] | null,
  total: Money | null,
): GateResultRow[] {
  return gates.map((gate) => {
    const mine = violations.filter((v) => v.gate === gate)
    const notEvaluated = (gate === 'totals' || gate === 'budget') && total === null
    return {
      gate,
      passed: notEvaluated ? null : mine.length === 0,
      // Every violation's text, not just the first: `checkSlots` can file two
      // (an unknown name and a wrong kind) and keeping only one would hide a
      // fault the model was told about.
      detail: mine.length === 0 ? null : mine.map((v) => v.detail).join(' '),
      sourceIds: mine.length === 0
        // A passing gate names nothing — except provenance, whose evidence IS
        // the set of ids it certified against the corpus.
        ? (gate === 'provenance' && items ? items.map((i) => i.item.sourceId) : [])
        : [...new Set(mine.flatMap((v) => v.sourceIds))],
    }
  })
}
