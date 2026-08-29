-- Comment-only. No data or schema change.
--
-- 0005 documented `passed IS NULL` as "not evaluated because a prerequisite gate
-- failed". That was written before the gate pipeline existed, and the pipeline
-- that now writes this table does not produce a single row for that reason:
-- when an earlier gate fails hard, the later gates are SKIPPED and write no row
-- at all. So the old comment describes a row shape that never occurs, while
-- saying nothing about the three that do. A wrong comment on an audit contract
-- is worse than no comment, because the next slice reads it instead of the code.

comment on column gate_results.passed is
  'Three verdicts. TRUE: the gate ran and was satisfied. FALSE: the gate ran and '
  'rejected the proposal -- a violation always wins, because a gate that rejected '
  'the proposal did evaluate it. NULL: the gate ran but could not reach a verdict, '
  'and `detail` says which of exactly three reasons applies -- '
  '"not evaluated: the total could not be computed" (checkTotals produced no total '
  'and filed no violation of its own, so the fault belongs to an earlier gate, in '
  'practice currency; recorded on both totals and budget), '
  '"not evaluated: no budget configured", or '
  '"not evaluated: no travel window configured" (the last two: there was no '
  'constraint to check, and counting those as passes would inflate the pass rate '
  'of a gate that never fired). '
  'A gate SKIPPED because an earlier gate failed writes NO ROW -- absence, not '
  'NULL. A hallucinated source id fails provenance and short-circuits, so such a '
  'run has one row, not seven. Absence is already distinguishable from "ran and '
  'passed" (no row vs a TRUE row) and is the honest denominator when counting how '
  'often a gate fired.';

comment on column gate_results.detail is
  'The violation text handed to the model when passed = FALSE (every violation for '
  'that gate, joined), or the not-evaluated reason when passed IS NULL. Always '
  'NULL when passed = TRUE. Enforced at the type level in src/repo/gateResults.ts, '
  'where GateResultRow is a discriminated union: a NULL verdict without a reason, '
  'and a pass that also explains itself, are both compile errors.';
