create table course.model_calls (
  id              uuid primary key default gen_random_uuid(),
  -- The order the calls were made in, for the same reason course.messages has
  -- one: a test that reads these rows back runs inside a single transaction,
  -- where every created_at is the same transaction_timestamp().
  seq             bigint generated always as identity,
  -- Null when a call runs outside a turn (a call made before submitMessage has
  -- created one, for instance). MATCH SIMPLE, Postgres's default, does not
  -- enforce the composite foreign key below when conversation_id is null, so
  -- that case still inserts.
  conversation_id uuid,
  turn_id         uuid references course.turns(id) on delete set null,
  user_id         uuid not null,
  seat            text not null check (seat in ('driver', 'cheap')),
  prompt_version  text not null,
  -- What we asked for, and what the API said it used. Two columns, because one
  -- cannot record a disagreement, and a column that can never disagree with
  -- itself proves nothing.
  model_requested text not null,
  model_returned  text not null,
  -- Four counters, not one. Cache writes and cache reads are billed at roughly
  -- 1.25x and 0.1x of the input rate, a difference of 12.5x that a single
  -- "cached tokens" column could not express.
  input_tokens                int not null default 0,
  cache_creation_input_tokens int not null default 0,
  cache_read_input_tokens     int not null default 0,
  output_tokens               int not null default 0,
  cost_micros     bigint not null default 0 check (cost_micros >= 0),
  latency_ms      int,
  created_at      timestamptz not null default now(),
  -- Same composite key as turns and messages, so a row can never be attached
  -- to another user's conversation, and it is cleared out with the
  -- conversation rather than surviving to quietly defeat the retention index.
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);
-- What did this conversation cost, and where did it go.
create index model_calls_cost on course.model_calls (conversation_id, seat);
-- What can be deleted when the retention window passes.
create index model_calls_retention on course.model_calls (created_at);
