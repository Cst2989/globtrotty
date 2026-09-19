-- Plan 4a final review, I2. Narrow the browser's read on `agent_events`.
--
-- `screenReply` (src/worker.ts) writes the withheld reply verbatim into
-- `agent_events` as `{ kind: 'screened', payload: { reason, original } }` so an
-- operator can see what the outbound filter replaced. Migration 0016's
-- `own_agent_events` policy granted the signed-in traveller SELECT on every row
-- of her own conversations, which included those rows — so the exact text the
-- filter withheld from her (a model-authored "what is your CVV?", say) was one
-- PostgREST call away: /rest/v1/agent_events?kind=eq.screened.
--
-- It is her own conversation, so this was never a cross-user leak, and the UI
-- never rendered it. But the control's stated purpose is that the flagged
-- message does not reach her, so the row that holds it must not be readable by
-- the role it was withheld from. Owner-connection reads (the worker, the route
-- handlers, the monitor) are unaffected: RLS is enabled, never forced.
drop policy own_agent_events on agent_events;
create policy own_agent_events on agent_events for select to authenticated
  using (user_id = auth.uid() and kind <> 'screened');
