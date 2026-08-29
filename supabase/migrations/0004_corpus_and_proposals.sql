-- The provenance corpus. Append-only and UNTRIMMED: the model reads a trimmed
-- view of search results, the gate reads this. Rehydration is a point read on
-- (conversation_id, source_id), so that pair is unique rather than merely indexed.
create table tool_results (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete set null,
  source_id       text not null,
  supplier        text not null,
  kind            text not null check (kind in ('flight','hotel')),
  name            text not null,
  price_minor     bigint not null check (price_minor >= 0),
  currency        char(3) not null,
  price_basis     text not null check (price_basis in ('total','pre_tax')),
  booking_url     text,
  search_params   jsonb not null default '{}'::jsonb,
  payload         jsonb not null,
  fetched_at      timestamptz not null default now(),
  ttl_seconds     int not null check (ttl_seconds > 0),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade,
  unique (conversation_id, source_id)
);
-- Rehydration reads many source_ids for one conversation in one statement.
create index tool_results_lookup on tool_results (conversation_id, fetched_at desc);

create table proposals (
  id                     uuid primary key default gen_random_uuid(),
  conversation_id        uuid not null,
  user_id                uuid not null,
  turn_id                uuid references turns(id) on delete set null,
  itinerary              jsonb not null,          -- REHYDRATED, never the model's version
  itinerary_schema_version int not null default 1,
  requirements_snapshot  jsonb not null,
  total_minor            bigint not null check (total_minor >= 0),
  currency               char(3) not null,
  gate_outcome           text not null
                           check (gate_outcome in ('approved','shipped_unapproved','rejected')),
  review_rounds          int not null default 0 check (review_rounds >= 0),
  review_issues          jsonb not null default '[]'::jsonb,
  decision               text check (decision in ('accept','reject')),
  reject_reason          text,
  decided_at             timestamptz,
  accepted_total_minor   bigint check (accepted_total_minor >= 0),
  accepted_currency      char(3),
  prompt_version         text,
  model_config_id        text,
  created_at             timestamptz not null default now(),
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade,
  -- The cashier reads (id, conversation_id); a bare id would let one conversation's
  -- proposal_id be handed off from another conversation's turn.
  unique (id, conversation_id)
);
create index proposals_by_conversation on proposals (conversation_id, created_at desc);

-- Every gate outcome, pass or fail. A table that only recorded failures could not
-- answer "how often did freshness fire?", which is the question slice 2 asks first.
create table gate_results (
  id            uuid primary key default gen_random_uuid(),
  proposal_id   uuid references proposals(id) on delete cascade,
  conversation_id uuid not null,
  turn_id       uuid references turns(id) on delete set null,
  gate          text not null
                  check (gate in ('provenance','freshness','currency','totals','budget','dates','reviewer')),
  passed        boolean not null,
  round         int not null default 0 check (round >= 0),
  detail        text,
  source_ids    text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index gate_results_by_proposal on gate_results (proposal_id);
create index gate_results_by_gate on gate_results (gate, passed, created_at desc);

create table link_clicks (
  id           uuid primary key default gen_random_uuid(),
  proposal_id  uuid not null references proposals(id) on delete cascade,
  turn_id      uuid references turns(id) on delete set null,
  user_id      uuid not null,
  item_id      text not null,
  supplier     text not null,
  url          text not null,
  tracking_ref text not null unique,
  quoted_minor bigint not null check (quoted_minor >= 0),
  currency     char(3) not null,
  rendered_at  timestamptz not null default now(),
  clicked_at   timestamptz,
  unique (proposal_id, item_id)
);

-- Created EMPTY in slice 1. The join key (tracking_ref) is what cannot be added
-- later; the rows themselves arrive months after the click.
create table conversions (
  id              uuid primary key default gen_random_uuid(),
  tracking_ref    text not null,
  supplier        text not null,
  booked_at       timestamptz,
  amount_minor    bigint check (amount_minor >= 0),
  currency        char(3),
  commission_minor bigint check (commission_minor >= 0),
  reported_at     timestamptz not null default now()
);
create index conversions_by_ref on conversions (tracking_ref);

-- Same posture as 0003: no browser role reaches these tables. Policies arrive
-- with the UI in plan 4, together with a two-user isolation test.
revoke all on tool_results, proposals, gate_results, link_clicks, conversions
  from anon, authenticated;
alter table tool_results  enable row level security;
alter table proposals     enable row level security;
alter table gate_results  enable row level security;
alter table link_clicks   enable row level security;
alter table conversions   enable row level security;
