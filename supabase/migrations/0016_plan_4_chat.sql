-- Plan 4a. Four changes, all for the browser client that now exists.
--
-- 1. messages.role gains 'action': a button press (accept / reject / revise) stored
--    as a JSON row written only by route handlers, hydrated by the worker into a
--    mid-conversation SYSTEM message. Never user text, so never forgeable by text.
-- 2. agent_events.kind gains 'screened': an agent reply the outbound filter replaced.
-- 3. Realtime: conversations and messages join the publication so the browser
--    can refetch on change. Conditional: the CI container has no publication.
-- 4. Row security for the browser: enable-only RLS (0003) with SELECT policies for
--    `authenticated` on user-owned tables. NOT forced — the worker is the owner,
--    and 0003 documents why forcing would break the global ceiling's sum. No
--    write grants: every write is a route handler on the owner connection.

alter table messages drop constraint messages_role_check;
alter table messages add constraint messages_role_check check (role in ('user','agent','action'));

alter table agent_events drop constraint agent_events_kind_check;
alter table agent_events add constraint agent_events_kind_check
  check (kind in ('tool_start','tool_done','thinking','parked','failed','continued','screened'));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table conversations, messages;
  end if;
end $$;

-- Reads for the signed-in traveller. `authenticated` had every privilege revoked in
-- 0003; this grants SELECT back on exactly the tables the app renders from.
grant select on conversations, messages, turns, proposals, link_clicks, agent_events,
                escalations, tool_results, gate_results to authenticated;

create policy own_conversations on conversations for select to authenticated using (user_id = auth.uid());
create policy own_messages      on messages      for select to authenticated using (user_id = auth.uid());
create policy own_turns         on turns         for select to authenticated using (user_id = auth.uid());
create policy own_proposals     on proposals     for select to authenticated using (user_id = auth.uid());
create policy own_link_clicks   on link_clicks   for select to authenticated using (user_id = auth.uid());
create policy own_agent_events  on agent_events  for select to authenticated using (user_id = auth.uid());
create policy own_escalations   on escalations   for select to authenticated using (user_id = auth.uid());
create policy own_tool_results  on tool_results  for select to authenticated using (user_id = auth.uid());
-- gate_results carries no user_id (0004): join through the conversation.
create policy own_gate_results  on gate_results  for select to authenticated
  using (exists (select 1 from conversations c where c.id = gate_results.conversation_id and c.user_id = auth.uid()));

-- RLS must be ENABLED on every table that now carries a policy; 0003/0004/0014/0015 did
-- this for most. Idempotent for the rest.
alter table turns        enable row level security;
alter table agent_events enable row level security;
alter table escalations  enable row level security;
