-- Spec section 6: `tool_results` is "untrimmed, append-only". It was not — plan 2
-- shipped `on conflict (conversation_id, source_id) do update`, so every
-- re-quote overwrote the previous price for that id and destroyed it
-- unrecoverably. Recorded as backlog 2.1, and as the only backlog item whose
-- cost could not be repaid by a later fix: the rows lost in between never
-- come back.
--
-- The unique constraint is what forced the upsert, so it goes. What replaces it
-- is an index that serves the new read shape: `rehydrate` now takes the newest
-- row per source_id via `distinct on`, which wants (conversation_id, source_id,
-- fetched_at desc, id desc) as its leading columns — the `id desc` term makes
-- the pick deterministic when two fetches share a `fetched_at`.
--
-- Growth becomes unbounded from here. Section 6 says these rows are retained at
-- least as long as `model_calls` (90 days); no reaper exists for either table
-- yet, and adding one is deliberately NOT part of this migration — see
-- docs/backlog-plan.md.

alter table tool_results
  drop constraint tool_results_conversation_id_source_id_key;

create index tool_results_newest_per_source
  on tool_results (conversation_id, source_id, fetched_at desc, id desc);
