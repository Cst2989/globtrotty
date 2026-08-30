-- Every gate outcome, pass or fail or could-not-say. A table that recorded only
-- failures could not answer "how often did freshness fire?", which is the first
-- question module 6's evals ask of this data (spec §4.3, lesson 6.2).
create table course.gate_results (
  id              uuid primary key default gen_random_uuid(),
  -- The write order, and the only thing a test may sort by. Every row a gate
  -- run writes lands in one statement inside one transaction, so they all share
  -- one created_at and `order by created_at` is unstable. Same reasoning as
  -- course.messages.seq in 0001.
  seq             bigint generated always as identity,
  conversation_id uuid not null,
  -- Carried for the same reason every other child table in this schema carries
  -- it (course.turns and course.messages in 0001, course.tool_results in 0010):
  -- the pair is what the composite foreign key below checks, so a gate row can
  -- never be attached to another user's conversation, and a user's rows can be
  -- deleted by user id alone the way test/helpers/db.ts deletes every other
  -- table's.
  user_id         uuid not null,
  turn_id         uuid references course.turns(id) on delete set null,
  -- The proposal these gates judged, once there is one. Nullable and WITHOUT a
  -- foreign key today, because course.proposals does not exist until 0013,
  -- which adds the constraint. Gates also run before a proposal row is written,
  -- so (conversation_id, user_id) is the only path back to the conversation for
  -- those rows and it is the pair that carries the cascade.
  proposal_id     uuid,
  round           int not null default 0 check (round >= 0),
  -- Seven deterministic gates plus 'reviewer', which needs a model and arrives
  -- in module 5. Accepting the value now costs nothing and means the seam does
  -- not need a migration later; GateName (src/gates/types.ts) deliberately does
  -- NOT include it, so nothing can write a row claiming a reviewer ran.
  gate            text not null check (gate in
                    ('provenance','freshness','slots','currency','totals','budget','dates','reviewer')),
  passed          boolean,
  detail          text,
  source_ids      text[] not null default '{}',
  created_at      timestamptz not null default now(),
  -- course.conversations declares unique (id, user_id) in 0001 precisely so its
  -- children can carry this pair, and the cascade is on it rather than on
  -- conversation_id alone.
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);

-- A conversation's gate rows, newest first: the read module 6.2 makes.
create index gate_results_by_conversation on course.gate_results (conversation_id, seq desc);
-- The foreign-key child column, leading its own index, so deleting a turn does
-- not scan this table. Partial for the same reason messages_by_turn (0008) is.
create index gate_results_by_turn on course.gate_results (turn_id) where turn_id is not null;
-- "How often did freshness fire?", which is the question this table exists for.
create index gate_results_by_gate on course.gate_results (gate, passed, seq desc);

comment on column course.gate_results.passed is
  'Three verdicts. TRUE: the gate ran and was satisfied. FALSE: the gate ran and '
  'rejected the proposal; a violation always wins, because a gate that rejected the '
  'proposal did evaluate it. NULL: the gate ran and could not reach a verdict, and '
  '`detail` says which of exactly three reasons applies. '
  '"not evaluated: the total could not be computed" means checkTotals produced no '
  'total and filed no violation of its own, so the fault belongs to an earlier gate, '
  'in practice currency; it is recorded on both totals and budget. '
  '"not evaluated: no budget configured" and '
  '"not evaluated: no travel window configured" mean there was no constraint to '
  'check, and counting those as passes would inflate the pass rate of a gate that '
  'never fired. '
  'A gate SKIPPED because an earlier gate failed writes NO ROW: absence, not NULL. A '
  'hallucinated source id fails provenance and short-circuits, so such a run has one '
  'row and not seven. Absence is already distinguishable from "ran and passed" (no '
  'row against a TRUE row) and is the honest denominator when counting how often a '
  'gate fired.';

comment on column course.gate_results.detail is
  'The violation text handed to the model when passed = FALSE, every violation for '
  'that gate joined, or the not-evaluated reason when passed IS NULL. Always NULL '
  'when passed = TRUE. Enforced at the type level in src/repo/gateResults.ts, where '
  'GateResultRow is a discriminated union: a NULL verdict without a reason, and a '
  'pass that also explains itself, are both compile errors.';

comment on column course.gate_results.proposal_id is
  'Null for a gate run that happened before a proposal row existed, which is every '
  'run at lesson 4.5 and the first round of every run after it. The foreign key to '
  'course.proposals is added by 0013, the migration that creates that table.';
