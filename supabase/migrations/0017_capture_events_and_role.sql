-- 0. The word for a request a person has to pick up is already here.
--
-- The plan for this lesson had this file drop conversations_status_check and add
-- it back with 'escalated' in it. That would have been a correction of something
-- nobody got wrong: 0004 wrote the constraint as
--
--   check (status in ('active', 'working', 'awaiting_user', 'limit_reached',
--                     'escalated', 'failed', 'archived'))
--
-- and 'escalated' has been an accepted value ever since. What was missing was
-- never the vocabulary. Nothing had ever WRITTEN the value, and nothing turned
-- any of the seven into a sentence a traveller reads; `statusInWords`
-- (src/channel.ts) and the escalation path (src/tools.ts, src/worker.ts) are
-- what this lesson adds, and neither needs a column changed.
--
-- Re-adding the constraint from the plan's shorter list would have been worse
-- than redundant. That list has five values and drops 'limit_reached' and
-- 'archived', and `failTurn` (src/repo/turns.ts) writes 'limit_reached' on a
-- capped conversation on every ceiling, so the migration would have broken a
-- live write in order to add a value the column already took.
--
-- 'escalated' is a conversation status and not a turn fail reason, and that
-- distinction is the whole of the decision. FAIL_REASONS and
-- turns_fail_reason_check do not move in this module: the turn that escalated
-- did not fail. It ran, it decided the request was outside what the agency can
-- do, it said so to her, and it ended `done`. What changed is who is expected to
-- act next, which is a property of the conversation.

-- 1. What a model call was actually sent, and what came back.
--
-- Nullable and written only when the capture policy says so (capturePolicyFor,
-- src/repo/model-calls.ts). A driver or front desk call is captured in full
-- because those are the calls anyone ever debugs; everything else is truncated
-- above 8KB, because a scout's fan-out is three rows per tool call and the
-- volume is the cost.
--
-- Every one of these columns is a credential exfiltration path by default:
-- anything that captures model input and output captures whatever was in it.
-- redactCredentials runs BEFORE serialisation and the result is parsed back to
-- an object, for the reason written on that function.
alter table course.model_calls add column request_id     text;
alter table course.model_calls add column capture_policy text
  check (capture_policy is null or capture_policy in ('full', 'truncated', 'sampled_out'));
alter table course.model_calls add column thinking_mode  text;
alter table course.model_calls add column system_prompt  text;
alter table course.model_calls add column user_prompt    text;
alter table course.model_calls add column response       jsonb;

comment on column course.model_calls.response is
  'The model response, with credentials redacted before serialisation and the '
  'result parsed back to an object. Stored as jsonb and never as a json string '
  'scalar: response->>''stop_reason'' on a string scalar is null forever.';

-- 2. What the agency did, in the order it did it, for the feed she watches and
-- for the monitor that alarms.
create table course.agent_events (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity,
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references course.turns(id) on delete set null,
  kind            text not null check (kind in ('tool_start', 'tool_done', 'thinking',
                                                'parked', 'failed', 'continued', 'escalated')),
  detail          text,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);
-- The feed, newest last, by seq and never by created_at. It leads on
-- conversation_id, which is also the first column of the composite key above, so
-- that key's child column is indexed by this one.
create index agent_events_feed on course.agent_events (conversation_id, seq);
-- The other foreign key's own index. No query of this table uses it and the
-- DELETE on the parent does: `on delete set null` has to find every event
-- pointing at a deleted turn, and without this it finds them with a sequential
-- scan per deleted row. PARTIAL, like user_memory_by_source_turn (0016) and
-- every turn index 0013 wrote, because the column is nullable: an event raised
-- outside a turn carries no turn id.
create index agent_events_by_turn on course.agent_events (turn_id) where turn_id is not null;

comment on table course.agent_events is
  'What the agency did during a turn, in seq order: the feed she watches and the '
  'rows the monitor reads. detail is a short server-written string, never the '
  'model''s own words.';

-- 3. The role the worker connects as, so that a forgotten `and user_id =` is a
-- row that is not returned rather than a row that is.
--
-- Created idempotently, because migrations run on a database that may already
-- have it and because a course reader's Supabase project is not ours to assume
-- anything about. The membership grant beside it is what lets `withUser`
-- (src/db.ts) run `set local role course_worker` at all. Postgres 16 and later
-- grant the creator that membership implicitly; saying it here makes the
-- migration independent of that, and it is inside the same branch as the create
-- so a pre-existing role somebody else owns is left exactly as it is.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'course_worker') then
    create role course_worker nologin;
    execute format('grant course_worker to %I', current_user);
  end if;
end
$$;

grant usage on schema course to course_worker;
grant usage, select on all sequences in schema course to course_worker;

-- Granted BY NAME, and never `on all tables in schema course`.
--
-- A blanket grant plus row level security on eight tables reads as though the
-- other five were left alone, and what it actually does is leave them wide open:
-- a table with a grant and no policy is a table every course_worker session
-- reads in full, for every user. The closing comment below argues at length that
-- daily_usage and model_calls must stay owner-read, and a blanket grant would
-- have made that comment describe the opposite of the migration it is written
-- on, which is this branch's worst defect class.
--
-- So the eight policied tables are granted, and the tables with no policy are
-- not granted at all. Nothing the worker needs is lost: the ceiling read and the
-- two sinks run on the owner connection, which is exactly where the comment at
-- the foot of this file already says they run.
grant select, insert, update, delete on
  course.conversations, course.turns, course.messages, course.tool_results,
  course.proposals, course.link_clicks, course.user_memory, course.agent_events
  to course_worker;

-- source_memory carries no user column and its facts are true for everybody, so
-- it gets no policy, and a policy is not what it needs. It gets the two verbs
-- the worker actually uses: it reads facts about a property into a prompt and it
-- writes one when it learns one. No update and no delete, because nothing in
-- this branch revises or retracts a source fact, and a verb granted for a caller
-- that does not exist is a verb an injected query gets for free.
grant select, insert on course.source_memory to course_worker;

-- course.model_calls, course.daily_usage, course.tool_calls and
-- course.gate_results are granted NOTHING. The first two are the money tables
-- and the closing comment below is about them. The other two carry a
-- traveller's data and are never read by user id on their own: the worker
-- reaches a tool call and a gate verdict through course.turns, which is under a
-- policy, and it writes them through the owner connection alongside the ledger.
-- test/isolation.test.ts asserts a course_worker session cannot read any of the
-- four at all, one case each, which is what makes this paragraph checkable
-- rather than merely stated.

alter table course.conversations enable row level security;
alter table course.turns         enable row level security;
alter table course.messages      enable row level security;
alter table course.tool_results  enable row level security;
alter table course.proposals     enable row level security;
alter table course.link_clicks   enable row level security;
alter table course.user_memory   enable row level security;
alter table course.agent_events  enable row level security;

-- One policy per table, on the user id the worker sets per transaction with
-- `set_config('course.user_id', ..., true)`. It is `current_setting(..., true)`,
-- with the missing_ok flag, so a connection that never set it reads nothing
-- rather than erroring: fail closed, the same rule readSpendFailClosed follows.
-- `for all` and one policy per table rather than four verbs per table: the
-- worker reads, inserts, updates and deletes its own rows and nobody else's,
-- and four policies saying the same predicate is four places for one of them to
-- drift. `with check` as well as `using`, so an INSERT that files a row under
-- somebody else's id is refused rather than written and then invisible.
create policy conversations_own on course.conversations for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy turns_own on course.turns for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy messages_own on course.messages for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy tool_results_own on course.tool_results for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy proposals_own on course.proposals for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy link_clicks_own on course.link_clicks for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy user_memory_own on course.user_memory for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

create policy agent_events_own on course.agent_events for all to course_worker
  using (user_id::text = current_setting('course.user_id', true))
  with check (user_id::text = current_setting('course.user_id', true));

-- course.source_memory gets RLS neither enabled nor a policy, and that is the
-- same decision the table itself records: it carries no user column, its facts
-- are true for everybody, and a policy on it would hide every one of them from
-- everybody. `grant select, insert` above is what the worker reads it with, and
-- a grant with no policy is safe HERE and only here, because there is no
-- traveller in the table to isolate.
-- course.gate_results and course.tool_calls stay owner-only, and "owner-only"
-- means no grant rather than a grant with no policy: the worker reaches them
-- through `course.turns`, which is under a policy, and neither is ever read by
-- user id on its own.

-- WHAT IS DELIBERATELY NOT UNDER A POLICY, and this is the important half.
--
-- course.daily_usage and course.model_calls stay owner-read. The global daily
-- ceiling runs `select sum(cost_micros) from course.daily_usage where day =
-- today` across ALL USERS on every ceiling check (src/repo/spend.ts). Under a
-- per-user policy that sum would silently return only the caller's own rows, so
-- the one ceiling that exists to stop the whole system spending unbounded money
-- in a day would simply stop firing, with no error and no failing test. A
-- security control that disables a money control is not an improvement. The
-- ceiling read therefore runs on the owner connection and everything that
-- touches a traveller's own rows runs as course_worker.
--
-- RLS is ENABLED and not FORCED here. The owner bypasses it, which is what makes
-- the paragraph above possible and what lets `npm run migrate` and the demo
-- script work at all. That is a real limitation, stated rather than hidden: the
-- isolation this buys is against a query the worker forgot to scope, and not
-- against an attacker who has the owner's connection string.
