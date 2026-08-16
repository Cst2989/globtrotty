-- turns_sweeper (0001) is on coalesce(heartbeat_at, queued_at) and serves the
-- batch query's `order by coalesce(heartbeat_at, queued_at) limit`. But the
-- sweeper's WHERE compares heartbeat_at and queued_at *separately*, each
-- against its own threshold and status — that predicate shape can't be
-- satisfied from a scan keyed on the coalesced expression. Add two narrower
-- partial indexes, one per status arm, so each half of the OR can be seeked
-- directly instead of falling back to a filtered scan.
create index turns_sweeper_running on turns (heartbeat_at) where status = 'running';
create index turns_sweeper_queued  on turns (queued_at)    where status = 'queued';
