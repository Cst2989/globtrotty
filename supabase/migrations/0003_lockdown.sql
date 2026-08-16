-- Locks down the schema now that it's pushed to a live hosted Supabase project,
-- before any browser client exists to need broader access. Supabase grants
-- `anon` and `authenticated` full DML on new `public` tables by default —
-- unrevoked, either key could write straight into spend counters
-- (conversations.spend_usd_micros, daily_usage.cost_micros) or anything else in
-- this schema. No browser client exists yet, so the anon key is unpublished, but
-- close this now rather than waiting until it is.

revoke all privileges on all tables in schema public from anon, authenticated;

-- RLS is enabled (NOT FORCED) with NO POLICIES here, deliberately.
--
-- The worker connects directly as the table owner, which bypasses non-forced
-- RLS entirely regardless of policies — that is what keeps the current test
-- suite (and every direct-as-owner write in src/) passing against these
-- tables. `force row level security` with zero policies would deny every row
-- to everyone, including the owner-connected worker, and break the whole
-- suite. Enabling (non-forced) RLS with no policies is a no-op for the owner
-- connection and simply means: no other role can read or write these tables
-- at all, on top of the revoke above.
--
-- Forcing RLS and adding real policies land together with the browser client
-- in a later plan, once there is an actual anon/authenticated access pattern
-- to write policies for. Do not add `force row level security` or any policy
-- here ahead of that.

alter table conversations   enable row level security;
alter table turns           enable row level security;
alter table messages        enable row level security;
alter table agent_events    enable row level security;
alter table tool_calls      enable row level security;
alter table model_calls     enable row level security;
alter table daily_usage     enable row level security;
alter table user_memory     enable row level security;
alter table source_memory   enable row level security;
