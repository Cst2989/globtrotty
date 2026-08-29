-- Existing rows predate the column and each one is its own press, so they are
-- backfilled with their own id before the column is made required.
alter table course.turns add column idempotency_key text;
update course.turns set idempotency_key = id::text where idempotency_key is null;
alter table course.turns alter column idempotency_key set not null;

-- The same press, retried, is the same turn. Scoped to the USER, not the
-- conversation: a first press arrives with no conversation yet, so a key
-- compared only against a conversation could never recognise a retry of that
-- very press, and fifty concurrent first presses of one key would each buy
-- their own conversation before the key was ever compared to anything.
alter table course.turns add constraint turns_user_idempotency
  unique (user_id, idempotency_key);

-- Busy and limit_reached open no turn, so the constraint above cannot dedupe a
-- retry of either. Her message row is the only durable trace those two paths
-- leave, so the same key goes on it too; null stays allowed, since only
-- `submitMessage` ever sets it and nothing else in the course writes here.
alter table course.messages add column idempotency_key text;
alter table course.messages add constraint messages_user_idempotency
  unique (user_id, idempotency_key);

-- One active turn per conversation. This is the fifty presses guard, and it is a
-- partial index because it must not stop her from ever having a second turn,
-- only from having two at once. `turns_live` from 0001 covered the same rows
-- without enforcing anything, so it is replaced rather than kept beside this.
drop index if exists course.turns_live;
create unique index turns_one_active_per_conversation
  on course.turns (conversation_id) where status in ('queued', 'running');

-- The sweeper's index, ready for module 3. Partial, so it stays small as done
-- rows accumulate.
create index turns_sweeper on course.turns (coalesce(heartbeat_at, queued_at))
  where status in ('queued', 'running');

-- Statuses were plain text until now, so 'workin' was a status and nothing said
-- otherwise. Each list below is the whole set of values its column may hold.
-- 'failed' is reserved for module 3's crash handling: every turn this module
-- closes ends 'done', with fail_reason beside it naming why when there was one.
alter table course.turns add constraint turns_status_check
  check (status in ('queued', 'running', 'done', 'failed'));

-- Mirrors the FailReason union in src/engine.ts exactly. A value added to one
-- and not the other fails test/schema.test.ts rather than an insert at 3am.
alter table course.turns add constraint turns_fail_reason_check
  check (fail_reason in ('provider_down', 'fetch_failed', 'limit_reached',
                         'step_cap', 'deadline_exceeded', 'crash_loop',
                         'fenced', 'stalled',
                         'refused', 'provider_rejected', 'unclassified'));

alter table course.conversations add constraint conversations_status_check
  check (status in ('active', 'working', 'awaiting_user', 'limit_reached',
                    'escalated', 'failed', 'archived'));

alter table course.conversations add constraint conversations_desk_check
  check (desk in ('front', 'planning'));
