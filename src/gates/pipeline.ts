import type postgres from 'postgres'
import { ProposalRefsSchema, rehydrateRefs } from './rehydrateGate.js'
import { checkFreshness, checkSlots, checkTotals, checkBudget, checkDates } from './checks.js'
import { recordGateResults, type GateResultRow } from '../repo/gateResults.js'
import type { Money } from '../money.js'
import { GATE_NAMES } from './types.js'
import type { GateName, GateOutcome, RehydratedItem, Violation } from './types.js'

import type { NotebookConstraints } from './notebookConstraints.js'

// Re-exported so the gates' one consumer imports its whole contract from here.
export type { NotebookConstraints } from './notebookConstraints.js'
export { constraintsFromNotebook } from './notebookConstraints.js'

/**
 * Why a `passed = null` row is null. `null` has more than one cause, so the
 * reason goes in `detail` — two different nulls that read identically are, for
 * anyone querying this table later, one null.
 *
 * Exported so the tests assert the exact text rather than a regex that any
 * message satisfies, and so a later reader of `gate_results` can match on a
 * constant instead of a copied string literal.
 */
export const NOT_EVALUATED = {
  noTotal:  'not evaluated: the total could not be computed',
  noBudget: 'not evaluated: no budget configured',
  noWindow: 'not evaluated: no travel window configured',
} as const

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
 * ## Never throws on model-controlled input
 *
 * Every check returns violations. The throwing calls underneath (`sumMoney` on
 * an empty list, `addMoney`/`compareMoney` on a currency mismatch, `itemTotal`
 * on a fractional quantity) are guarded inside the checks themselves, so nothing
 * the MODEL can put in a proposal reaches one — which is the property that
 * matters, since the model's output is the untrusted input here.
 *
 * The qualifier is deliberate rather than decorative, because the claim is not
 * absolute one hop out. Rehydration reads the corpus back, and a `tool_results`
 * row with a corrupt `price_minor` or an unknown `currency` throws inside
 * `money()` before any gate sees it, while `checkDates` dereferences `payload`
 * jsonb that was written as `SupplierItem.detail` but is read back unvalidated.
 * Neither is reachable today: every corpus row is written by a supplier port
 * through `recordResults`, from an already-typed `SupplierItem`. Both would
 * become reachable the moment anything else writes that table, and the fix then
 * is to validate on the way OUT of `rehydrate`, not to wrap gates in try/catch.
 *
 * What can also throw is the database write, which is a real failure of the turn
 * and must not be swallowed.
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
    // The gate list is derived from the violations here, not hard-coded to
    // ['provenance'], for the same reason the rows below are bucketed by
    // `v.gate`: the gate name on the violation decides the row, never the call
    // site. A hard-coded list would silently DROP any fault `rehydrateRefs`
    // grows a new name for.
    await write(rowsFor([...new Set(hydrated.violations.map((v) => v.gate))],
                        hydrated.violations, null, {}))
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
  // requires >= 1 ref, so it cannot happen here) or alongside a violation —
  // its own, or `checkCurrency`'s. The guard exists so that a future change to
  // it cannot make this function return `ok: false` with nothing to tell the
  // model. Note what filing this violation does to the row: it makes `totals`
  // read `false` rather than `null`, which is correct and not an exception to
  // the rule below. A gate that produced no total and has NO upstream gate
  // explaining why is itself the fault; `null` is for the case where another
  // gate already owns it.
  if (totals.total === null && violations.length === 0) {
    violations.push({
      gate: 'totals',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: 'These items could not be totalled. Re-search them and propose the new ids.',
    })
  }

  // Why each gate that could not reach a verdict could not reach one. A gate
  // named here records `passed = null` UNLESS it also filed a violation — a
  // violation always wins, because a gate that rejected the proposal did in
  // fact evaluate it.
  const notEvaluated: Partial<Record<GateName, string>> = {}
  if (totals.total === null) {
    notEvaluated.totals = NOT_EVALUATED.noTotal
    notEvaluated.budget = NOT_EVALUATED.noTotal
  }
  // Deliberately AFTER the `noTotal` assignment, so it wins: if no budget was
  // ever configured, that is why the budget gate did not evaluate, whatever
  // else was also true. Even a perfect total would not have been checked.
  if (args.notebook.budget === null) notEvaluated.budget = NOT_EVALUATED.noBudget
  if (args.notebook.window === null) notEvaluated.dates = NOT_EVALUATED.noWindow
  // `currency` is NOT listed here even when the notebook has no currency, and
  // the asymmetry is deliberate. `checkBudget` and `checkDates` have nothing to
  // do without their constraint; `checkCurrency` with `expected === null` still
  // runs a real check — that the items agree with EACH OTHER, which is the
  // precondition `sumMoney` needs — so it reaches a genuine verdict either way.

  await write(rowsFor(GATE_NAMES, violations, items, notEvaluated))

  // Written as a positive condition on `total` rather than `total!` after a
  // violations check: `ok: true` must be unable to carry a fabricated total,
  // and a non-null assertion is exactly the construct that would let it.
  if (violations.length === 0 && totals.total !== null) {
    return { ok: true, items, total: totals.total }
  }
  return { ok: false, violations }
}

/**
 * One row per gate, bucketed by `Violation.gate`.
 *
 * ## The three verdicts
 *
 * 1. **`false`** — the gate filed a violation. This is checked FIRST and beats
 *    everything: a gate that rejected the proposal evaluated it, by definition.
 * 2. **`null`** — the gate is named in `notEvaluated`, meaning it could not
 *    reach a verdict. `detail` says which reason, because there is more than
 *    one and a null that does not say why is a null nobody can query.
 * 3. **`true`** — the gate ran and was satisfied.
 *
 * ## Why `null` exists at all
 *
 * Two false audit records, one in each direction, and both are easy to write:
 *
 *  - **A pass that never happened.** The violation list does not partition by
 *    gate the way bucketing assumes: a mixed-currency proposal returns
 *    `{violations: [<currency>], total: null}` — ZERO violations tagged
 *    `totals` — and `checkBudget` correctly returns `[]` because there is no
 *    number to compare. Bucketing alone records
 *    `currency: fail, totals: pass, budget: pass`, asserting that a trip total
 *    was computed and checked when none exists, from the one gate whose whole
 *    job was to refuse to compute it. The same goes for a gate with no
 *    constraint to check: counting the budget gate as a pass on every
 *    conversation that never set a budget inflates its pass rate and makes a
 *    gate that never fired look useless.
 *  - **A rejection recorded as "not evaluated."** The mirror image, and the
 *    reason the violation check comes first. `checkTotals` returns
 *    `total === null` for a mixed price basis and a bad quantity too — but in
 *    those it DID evaluate and DID reject, and filing that under `null` would
 *    lose the fault exactly as surely as filing it under `pass`.
 *
 * So `totals` is `null` only when it neither summed nor rejected — precisely
 * the mixed-currency case, where the fault belongs to `currency` and is
 * recorded there.
 */
function rowsFor(
  gates: readonly GateName[],
  violations: readonly Violation[],
  items: RehydratedItem[] | null,
  notEvaluated: Partial<Record<GateName, string>>,
): GateResultRow[] {
  return gates.map((gate): GateResultRow => {
    const mine = violations.filter((v) => v.gate === gate)
    if (mine.length > 0) {
      return {
        gate,
        passed: false,
        // Every violation's text, not just the first: `checkSlots` can file two
        // (an unknown name and a wrong kind) and keeping only one would hide a
        // fault the model was told about.
        detail: mine.map((v) => v.detail).join(' '),
        sourceIds: [...new Set(mine.flatMap((v) => v.sourceIds))],
      }
    }
    const reason = notEvaluated[gate]
    if (reason !== undefined) return { gate, passed: null, detail: reason, sourceIds: [] }
    return {
      gate,
      passed: true,
      detail: null,
      // A passing gate names nothing — except provenance, whose evidence IS the
      // set of ids it certified against the corpus.
      sourceIds: gate === 'provenance' && items ? items.map((i) => i.item.sourceId) : [],
    }
  })
}
