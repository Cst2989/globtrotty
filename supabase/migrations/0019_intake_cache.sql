-- Polish pass, section 10: the intake brief, cached per traveller and message.
--
-- `runIntake` (src/agents/intake.ts) asks Jev to turn one typed sentence into a
-- `TripBrief`. The same sentence always produces the same brief, and she sends
-- the same sentence more often than one would think: a retry after a failed
-- turn, a second conversation about the same trip, the chip she clicked being
-- posted as its own label. Each one was a model call.
--
-- Keyed on sha256(user_id + the normalised message), per user: two travellers
-- typing the same words get their own rows. Scoping the key to the user is not
-- about the brief's contents — "a week in Lisbon in September" means the same
-- thing whoever types it — but about never letting one account's activity be
-- inferred from another's cache timing.
--
-- `unique (user_id, hash)` is what makes the write an upsert rather than a
-- source of duplicates; the TTL is applied on READ (24 hours, in
-- src/agents/intakeCache.ts) rather than by a reaper, same posture as every
-- other freshness window in this codebase. There is no reaper for this table
-- yet, exactly as there is none for `tool_results` or `model_calls` — see
-- docs/backlog-plan.md.
--
-- RLS: enabled, and NO policy for anon or authenticated. A brief holds the
-- traveller's own trip in structured form; nothing in the browser has any
-- reason to read it, and the owner connection (the worker) is what writes and
-- reads it. The blanket revoke is the same one migrations 0003/0004 apply to
-- `model_calls`, `tool_calls` and `daily_usage`, for the same reason: a table
-- with RLS on and no policy still needs its grants taken away, or a future
-- policy added by accident is the only thing standing between it and the
-- browser.
create table if not exists intake_cache (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  hash       text not null,
  brief      jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, hash)
);

create index if not exists intake_cache_user_created_idx
  on intake_cache (user_id, created_at desc);

alter table intake_cache enable row level security;
revoke all on intake_cache from anon, authenticated;
