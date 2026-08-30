-- Without this, two runGates calls in one turn that share a `round` write two
-- full seven-row sets and every `group by gate` fire-rate double-counts. Plan 3
-- derived `round` deliberately and left the constraint to a later plan; plan 3b's
-- `revise_component` creates multiple rounds per turn by design, so this is that
-- plan.
--
-- The key is (turn_id, round, gate), NOT (conversation_id, ...). `round` is
-- derived per TURN -- countPriorProposals (src/repo/toolCalls.ts) filters on
-- turn_id -- so it resets to 0 on every turn, and a conversation-scoped key
-- would reject turn 2's legitimate round 0.
--
-- `proposal_id` is deliberately NOT in the key: it is an OUTCOME of the gate run
-- (null when the gates rejected), not part of its identity.
--
-- PARTIAL, on `turn_id is not null`, because turn_id is `on delete set null`.
-- A total index would make deleting a turn fail as soon as two orphaned rows
-- collided -- turning a retention delete into an error, which is precisely the
-- kind of guard that fires on the wrong thing.

create unique index gate_results_one_row_per_gate_per_round
  on gate_results (turn_id, round, gate)
  where turn_id is not null;
