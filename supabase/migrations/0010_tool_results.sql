-- The provenance corpus. Every search result, untrimmed, one row per fetch.
--
-- The model reads a trimmed view of a search (src/tools.ts's itemForModel drops
-- the booking URL and formats the price); a gate reads THIS. That is the whole
-- point of the table: the gate and the model must not be reading the same
-- object, or a model that changed one number would have changed the evidence
-- too.
--
-- APPEND-ONLY, and deliberately so. There is no unique constraint on
-- (conversation_id, source_id): a re-search of an item writes a SECOND row and
-- the first one stays. The obvious alternative, `unique (conversation_id,
-- source_id)` with an upsert, is what the product's own main branch shipped,
-- and its own comment records the cost: every re-quote overwrites the previous
-- price for that id, so the table can answer "what does the corpus hold for X
-- now" and cannot answer "what price did a gate see for X at 14:03", which is
-- the question a replay of a recorded conversation asks first. That loss is
-- silent and unrecoverable. This branch has no live rows to lose, so it takes
-- the row-per-fetch shape at the start rather than owing the conversion later.
--
-- The cost of THIS choice, stated so nobody has to rediscover it: the table
-- grows without bound and nothing prunes it. Module 7's retention schedule is
-- where that is answered. Until then the growth is one row per item per search
-- per conversation, which for a course is nothing.
create table course.tool_results (
  id              uuid primary key default gen_random_uuid(),
  -- The write order, and the only thing anything sorts equal timestamps by. A
  -- supplier can return one native id twice in one response and both copies
  -- carry the same fetched_at, because one call stamped them; without seq,
  -- "the newest row for this id" would be whichever the planner returned first.
  -- Same reasoning as course.messages.seq in 0001.
  seq             bigint generated always as identity,
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references course.turns(id) on delete set null,
  -- The supplier's own id for this item, verbatim. A re-quote finds by it
  -- (lesson 4.6), so it is never normalised, lower-cased or trimmed.
  source_id       text not null,
  supplier        text not null,
  kind            text not null check (kind in ('flight','hotel')),
  name            text not null,
  -- A TRAVELLER's money, in the supplier's currency and that currency's minor
  -- units. Not our spend: course.turns.spend_usd_micros and
  -- course.conversations.spend_usd_micros are USD micros of what we paid the
  -- model. Both are bigints, neither converts into the other, and putting one
  -- where the other belongs is a bug no type system in this branch would catch.
  price_minor     bigint not null check (price_minor >= 0),
  currency        char(3) not null,
  price_basis     text not null check (price_basis in ('total','pre_tax')),
  -- Supplier-supplied, therefore untrusted, and never emitted. Lesson 4.6
  -- builds every link she clicks from (supplier, source_id, tracking ref)
  -- against an allowlisted host. Kept because module 7 wants to know what the
  -- supplier said.
  booking_url     text,
  -- The search that produced this row, so lesson 4.6's re-quote has something
  -- to re-run. A quote that could not reproduce its own search would have to
  -- guess one.
  search_params   jsonb not null default '{}'::jsonb,
  -- SupplierItem.detail, verbatim: the typed record a gate reads. jsonb rather
  -- than columns because its shape differs by kind and no gate queries into it.
  payload         jsonb not null,
  fetched_at      timestamptz not null default now(),
  ttl_seconds     int not null check (ttl_seconds > 0),
  -- The composite key every child table in this schema carries (0001), so a
  -- result can never be attached to another user's conversation.
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);

-- Rehydration is `select distinct on (source_id) ... where conversation_id = $1
-- and source_id = any($2) order by source_id, fetched_at desc, seq desc`. The
-- index leads on the two equality columns and then carries the sort, so the
-- newest row per id is a seek rather than a scan and a sort of every fetch that
-- conversation ever made.
create index tool_results_rehydrate
  on course.tool_results (conversation_id, source_id, fetched_at desc, seq desc);

-- The foreign-key child column, so deleting a turn does not scan this table.
-- Partial, because the rows with a null turn_id are exactly the ones that
-- question never asks about. Same shape as messages_by_turn in 0008.
create index tool_results_by_turn on course.tool_results (turn_id) where turn_id is not null;

comment on table course.tool_results is
  'Row isolation is NOT enforced here. Nothing in this branch connects as anything '
  'but the owning role, so a policy would be bypassed rather than applied, and '
  'enabling row level security with no policy would lock out a reader connecting as '
  'anyone else. The composite foreign key to course.conversations (id, user_id) is '
  'what keeps a row attached to the right user today. The RLS worker role, and the '
  'policies that need it, are lesson 5.7.';
