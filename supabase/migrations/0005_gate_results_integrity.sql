-- 0004_corpus_and_proposals.sql is already applied to the live hosted project,
-- so these fixes to gate_results arrive as a follow-up migration rather than
-- an edit to 0004. Three defects, found by a pre-flight consistency scan and
-- by Task 10's review, all block Task 11 (the first task to write gate_results
-- rows):
--
-- 1. conversation_id was not null but had neither a foreign key nor an index.
--    Task 11 writes every row with proposal_id = null (gates run before a
--    proposal row exists), and proposal_id was the table's only cascade path,
--    so deleting a conversation left every gate_results row behind forever.
-- 2. Task 11 queries `where conversation_id = ...`; that path had no index.
-- 3. `passed boolean not null` cannot express "not evaluated". Task 10's
--    checkBudget (and checkTotals) correctly emit no violation when a
--    prerequisite gate already killed the proposal -- there is no total to
--    compare against. passed = true would be a lie; no row at all would be
--    indistinguishable from "we forgot to run the gate".

-- conversations.id is the primary key, and gate_results has no user_id column,
-- so a single-column FK is correct here -- unlike tool_results/proposals,
-- there is no (conversation_id, user_id) composite to form.
alter table gate_results
  add constraint gate_results_conversation_id_fkey
    foreign key (conversation_id) references conversations (id) on delete cascade;

-- Task 11 reads a conversation's gate rows newest-first.
create index gate_results_by_conversation on gate_results (conversation_id, created_at desc);

-- The real constraint name (gate_results_gate_check) was confirmed against
-- pg_constraint rather than guessed, per plan discipline.
alter table gate_results drop constraint gate_results_gate_check;
alter table gate_results
  add constraint gate_results_gate_check
    check (gate in ('provenance','freshness','currency','totals','budget','dates','reviewer','slots'));

alter table gate_results alter column passed drop not null;
comment on column gate_results.passed is
  'NULL means "not evaluated because a prerequisite gate failed" -- e.g. checkBudget '
  'and checkTotals emit no row content to compare when an earlier currency/totals '
  'fault already rejected the proposal. Distinct from omitting the row entirely, '
  'which would be indistinguishable from "we forgot to run the gate".';
