-- Two tables and not one, and the split is about who can be shown what.
--
-- course.user_memory is HER data: facts about a traveller, carried across every
-- conversation she ever has. It carries user_id and it is the table a per-user
-- row policy is written against, which is lesson 5.7's subject.
--
-- course.source_memory is OURS: facts about a supplier or a property, learned
-- once and true for everybody. It carries no user at all. A single agent_memory
-- table holding both would make the policy impossible to write: scoping it by
-- user would hide every source fact from everybody, and not scoping it would
-- show one traveller's facts to another. That is the whole reason for the split
-- and it is a schema decision taken for a security reason, which is the kind
-- that has to be written on the table rather than remembered.
create table course.user_memory (
  id          uuid primary key default gen_random_uuid(),
  -- The order the facts were written in, for the same reason course.messages has
  -- one: a test that reads these back runs inside a single transaction where
  -- every created_at is the same transaction_timestamp().
  seq         bigint generated always as identity,
  user_id     uuid not null,
  fact        text not null check (length(fact) between 1 and 500),
  -- Whether she said it or we concluded it. An inferred fact is shown to the
  -- model marked as inferred, so a plan built on one can be corrected by her
  -- rather than defended by us. It is the same distinction the notebook's
  -- provenance carries and it is kept for the same reason.
  inferred    boolean not null default false,
  -- Which turn learned it, so a fact can be traced back to what she actually
  -- wrote. Nullable and `on delete set null`: a fact outlives the turn that
  -- learned it, which is the whole point of the table, so a deleted turn must
  -- not take the fact with it.
  source_turn uuid references course.turns(id) on delete set null,
  created_at  timestamptz not null default now()
);
-- Her facts, newest first, which is the only query this table has.
create index user_memory_by_user on course.user_memory (user_id, seq desc);
-- The foreign key's own index, which no query of this table uses and which the
-- DELETE on the parent does: `on delete set null` has to find every fact
-- pointing at a deleted turn, and without this it finds them with a sequential
-- scan of the whole table per deleted row. Module 7's retention schedule deletes
-- turns in bulk. `test/schema-corpus.test.ts` audits the catalogue for exactly
-- this and would have caught it here whether or not anybody thought to look.
create index user_memory_by_source_turn on course.user_memory (source_turn);

comment on table course.user_memory is
  'Facts about one traveller, across every conversation. RLS-subject: this is the '
  'table a per-user policy is written against (lesson 5.7). Split from '
  'source_memory precisely so that policy can exist.';

create table course.source_memory (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity,
  -- supplier:sourceId, or supplier:property. Not a foreign key to
  -- course.tool_results: a fact about a property outlives every fetch of it, and
  -- the corpus is append-only and pruned by module 7's retention schedule.
  source_key text not null check (length(source_key) between 1 and 200),
  fact       text not null check (length(fact) between 1 and 500),
  created_at timestamptz not null default now()
);
create index source_memory_by_key on course.source_memory (source_key, seq desc);

comment on table course.source_memory is
  'Facts about a supplier or a property, true for every traveller and belonging to '
  'none of them. Deliberately carries no user_id: a per-user policy on this table '
  'would hide every fact from everybody.';
