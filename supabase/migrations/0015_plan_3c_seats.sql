-- Plan 3c.
--
-- 1. conversations.desk defaults to 'front': every new conversation is routed
--    by the front desk first (parent spec section 3). Existing rows keep
--    'planning' -- they were created before a front desk existed and must not
--    be re-triaged.
-- 2. conversations.front_label: the routing label, extracted at write time so
--    it outlives the 90-day model_calls window (parent section 7). 'fallback'
--    is the parse-failure / refusal route, distinct from a real 'unclear'.
-- 3. canary_runs / drift_alarms: the drift monitor's memory. A canary run is a
--    response fingerprint, never content; an alarm is a diff between two runs
--    or between a stored request shape and the code's current one.

alter table conversations alter column desk set default 'front';
alter table conversations add column front_label text
  check (front_label in ('new_trip','faq','unclear','fallback'));

create table canary_runs (
  id           uuid primary key default gen_random_uuid(),
  seat         text not null check (seat in ('front_desk','driver','scout','reviewer')),
  model        text not null,
  stop_reason  text not null,
  output_band  text not null check (output_band in ('xs','s','m','l','xl')),
  signal       text not null default '',
  request_id   text,
  ran_at       timestamptz not null default now()
);
create index canary_runs_by_seat on canary_runs (seat, ran_at desc);

create table drift_alarms (
  id           uuid primary key default gen_random_uuid(),
  seat         text not null,
  "check"      text not null check ("check" in ('canary','shape')),
  detail       jsonb not null,
  created_at   timestamptz not null default now(),
  notified_at  timestamptz
);
create index drift_alarms_recent on drift_alarms (created_at desc);

revoke all on canary_runs, drift_alarms from anon, authenticated;
alter table canary_runs  enable row level security;
alter table drift_alarms enable row level security;
