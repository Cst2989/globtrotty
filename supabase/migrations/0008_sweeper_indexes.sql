-- turns_sweeper (0004) is on coalesce(heartbeat_at, queued_at) and serves the
-- batch query's `order by coalesce(heartbeat_at, queued_at) limit`. The
-- sweeper's WHERE compares heartbeat_at and queued_at SEPARATELY, each against
-- its own threshold and its own status, and that predicate shape cannot be
-- satisfied from a scan keyed on the coalesced expression. One narrow partial
-- index per status arm, so each half of the OR can be seeked rather than
-- filtered. Both stay small, because `done` and `failed` rows are not in them.
create index turns_sweeper_running on course.turns (heartbeat_at) where status = 'running';
create index turns_sweeper_queued  on course.turns (queued_at)    where status = 'queued';

-- The sweeper asks "does this turn have a user message?" once per candidate.
-- messages_thread (0001) is on (conversation_id, seq) and cannot answer a
-- turn_id predicate, so without this the check is a scan of every message in the
-- database on every sweep. Partial, because the rows with a null turn_id are
-- exactly the ones this question never asks about.
create index messages_by_turn on course.messages (turn_id) where turn_id is not null;
