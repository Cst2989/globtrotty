create extension if not exists pgcrypto;

create table conversations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  title         text,
  desk          text not null default 'planning'
                  check (desk in ('front','planning')),
  status        text not null default 'active'
                  check (status in ('active','working','awaiting_user','limit_reached',
                                    'escalated','failed','archived')),
  requirements  jsonb not null default '{}'::jsonb,
  spend_usd_micros bigint not null default 0 check (spend_usd_micros >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, user_id)                     -- lets children carry a composite FK
);
create index conversations_user_updated on conversations (user_id, updated_at desc);

create table turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  status          text not null default 'queued'
                    check (status in ('queued','running','done','failed')),
  state           jsonb,
  attempts        int  not null default 0 check (attempts >= 0),
  idempotency_key text not null,
  queued_at       timestamptz not null default now(),
  started_at      timestamptz,
  heartbeat_at    timestamptz,
  finished_at     timestamptz,
  spend_usd_micros bigint not null default 0 check (spend_usd_micros >= 0),
  fail_reason     text check (fail_reason in ('provider_down','fetch_failed','limit_reached',
                                              'step_cap','deadline_exceeded','crash_loop',
                                              'fenced','stalled')),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade,
  unique (conversation_id, idempotency_key)
);

-- One active turn per conversation. This is the "she pressed the button 50 times" guard.
create unique index turns_one_active_per_conversation
  on turns (conversation_id) where status in ('queued','running');

-- The sweeper's only index. Partial, so it stays small as `done` rows accumulate.
create index turns_sweeper on turns (coalesce(heartbeat_at, queued_at))
  where status in ('queued','running');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete set null,
  role            text not null check (role in ('user','agent')),
  content         text not null,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade
);
create index messages_thread on messages (conversation_id, created_at);

create table agent_events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete cascade,
  kind            text not null
                    check (kind in ('tool_start','tool_done','thinking','parked',
                                    'failed','continued')),
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade
);
create index agent_events_feed on agent_events (conversation_id, created_at);

create table tool_calls (
  turn_id    uuid not null references turns(id) on delete cascade,
  call_id    text not null,
  name       text not null,
  status     text not null check (status in ('pending','done')),
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (turn_id, call_id)
);

create table model_calls (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid,
  turn_id           uuid,
  user_id           uuid not null,
  seat              text not null
                      check (seat in ('front_desk','driver','scout','reviewer',
                                      'monitor','titler','sim_user')),
  prompt_version    text not null,
  model_config_id   text not null,
  effort            text,
  thinking_mode     text,
  max_tokens        int,
  model             text not null,          -- resolved, from response.model
  request_id        text,
  system_prompt     text,                   -- nullable: capture_policy carries the meaning
  user_prompt       text,
  response          jsonb,
  input_tokens              int not null default 0,
  cache_creation_input_tokens int not null default 0,
  cache_read_input_tokens     int not null default 0,
  output_tokens             int not null default 0,
  cost_micros       bigint not null default 0 check (cost_micros >= 0),
  latency_ms        int,
  capture_policy    text not null check (capture_policy in ('full','truncated','sampled_out')),
  created_at        timestamptz not null default now()
);
create index model_calls_retention on model_calls (created_at);
create index model_calls_cost on model_calls (conversation_id, seat);

create table daily_usage (
  user_id    uuid not null,
  day        date not null,
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table user_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  fact       text not null,
  inferred   boolean not null,
  source_turn uuid,
  created_at timestamptz not null default now()
);
create index user_memory_by_user on user_memory (user_id, created_at desc);

create table source_memory (
  id         uuid primary key default gen_random_uuid(),
  source_key text not null,
  fact       text not null,
  created_at timestamptz not null default now()
);
create index source_memory_by_key on source_memory (source_key);
