create schema if not exists course;

create table course.conversations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  title         text,
  desk          text not null default 'planning',
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Lets children carry a composite foreign key, so a message can never be
  -- attached to another user's conversation.
  unique (id, user_id)
);
create index conversations_user_updated on course.conversations (user_id, updated_at desc);

create table course.turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  status          text not null default 'queued',
  state           jsonb,
  attempts        int not null default 0 check (attempts >= 0),
  queued_at       timestamptz not null default now(),
  started_at      timestamptz,
  heartbeat_at    timestamptz,
  finished_at     timestamptz,
  fail_reason     text,
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);
create index turns_live on course.turns (conversation_id) where status in ('queued', 'running');

create table course.messages (
  id              uuid primary key default gen_random_uuid(),
  -- The order the messages were written in, and the only thing anything sorts
  -- them by. `created_at` cannot do this job: its default is now(), which is
  -- transaction_timestamp(), so every row written inside one transaction shares
  -- one value. Every test in this course writes inside a single rolled-back
  -- transaction, so `order by created_at` there returns rows in whatever order
  -- the planner likes and a test that asserts ['one', 'two'] passes by luck.
  seq             bigint generated always as identity,
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references course.turns(id) on delete set null,
  role            text not null check (role in ('user', 'agent')),
  content         text not null,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);
create index messages_thread on course.messages (conversation_id, seq);
