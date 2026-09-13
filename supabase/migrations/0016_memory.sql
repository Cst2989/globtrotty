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

-- course.turns declares only `id primary key`, so there is nothing for a
-- composite key to reference yet. course.conversations has carried
-- `unique (id, user_id)` since 0001 for exactly this purpose, and this is the
-- first table that needs the same guarantee from a turn. Adding it here rather
-- than editing 0001, which is published and frozen, is what append-only means:
-- the correction lands in the first migration after the need for it.
alter table course.turns add constraint turns_id_user_id_key unique (id, user_id);

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
  source_turn uuid,
  created_at  timestamptz not null default now(),
  -- COMPOSITE, and this is the one line in the file that needs arguing.
  --
  -- Every other table that carries a turn id also carries a conversation, and
  -- its composite key to course.conversations (id, user_id) is what ties the row
  -- to a user; the bare `references course.turns(id)` beside it is then only a
  -- parent link. This table deliberately has no conversation, so nothing plays
  -- that role, and a single-column key here would let a fact belonging to one
  -- traveller point at another traveller's turn. This is the table lesson 5.7
  -- writes a per-user row policy against, and a policy is written over columns:
  -- a row that passes it on `user_id` while pointing at somebody else's turn is
  -- exactly the row that makes the policy a decoration.
  --
  -- `on delete set null (source_turn)` and not a bare `set null`, which would
  -- try to null `user_id` too and fail against its `not null`. The column list
  -- form needs Postgres 15 or later. Supabase provisions 15 or newer and this
  -- branch is developed against 17, so the floor is stated here rather than
  -- worked around.
  foreign key (source_turn, user_id) references course.turns (id, user_id)
    on delete set null (source_turn)
);
-- Her facts, newest first, which is the only query this table has.
create index user_memory_by_user on course.user_memory (user_id, seq desc);
-- The foreign key's own index, which no query of this table uses and which the
-- DELETE on the parent does: `on delete set null` has to find every fact
-- pointing at a deleted turn, and without this it finds them with a sequential
-- scan of the whole table per deleted row. Module 7's retention schedule deletes
-- turns in bulk. `test/schema-corpus.test.ts` audits the catalogue for exactly
-- this and would have caught it here whether or not anybody thought to look.
--
-- PARTIAL, like messages_by_turn (0008), gate_results_by_turn (0012) and every
-- turn index 0013 wrote, because the column is nullable and today it is null on
-- every row the production path writes: the driver learns no facts yet and
-- passes no source turn. An index of nothing but null entries is pure write
-- cost. The audit checks the leading column and accepts a partial index, so the
-- convention costs nothing.
create index user_memory_by_source_turn
  on course.user_memory (source_turn) where source_turn is not null;

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
