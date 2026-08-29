-- Two defects found by the whole-branch review, neither visible from inside a
-- single task.

-- ---------------------------------------------------------------------------
-- 1. Three unindexed foreign-key CHILD columns.
-- ---------------------------------------------------------------------------
-- §6 requires an index on every FK child column. 0005 exists specifically to
-- fix this class of defect on `gate_results.conversation_id`, but that audit
-- was scoped to `conversation_id` and never extended to `turn_id` — so all
-- three tables 0004 created carry `turn_id uuid references turns(id) on delete
-- set null` with nothing to serve it.
--
-- The cost is not hypothetical and it is not a read-path cost. Postgres does
-- not use an index to enforce a foreign key on the referencing side; what needs
-- one is the parent-side action. `on delete set null` means every `delete from
-- turns` — which is what a conversation cascade does, since turns cascade from
-- conversations — must find the referencing rows in all three children. With no
-- index that is three sequential scans per deleted turn, on the corpus table
-- that grows fastest of all of them. It is fast today because the tables are
-- small; it degrades linearly and never recovers.
--
-- Plain (not concurrent) creates: these run inside `supabase db push`'s
-- transaction, and the tables are small enough that the exclusive lock is
-- momentary. Revisit if either table grows past the point where a brief write
-- lock matters.
create index tool_results_by_turn on tool_results (turn_id);
create index proposals_by_turn    on proposals (turn_id);
create index gate_results_by_turn on gate_results (turn_id);

-- ---------------------------------------------------------------------------
-- 2. The forced-RLS hazard on `daily_usage`, said where a policy author reads.
-- ---------------------------------------------------------------------------
-- 0003 carries a long warning about this, addressed to whoever later adds RLS
-- policies. The problem is that it lives in migration 0003's comments, and a
-- policy author does not read migration history — they read the table. So the
-- warning is attached to the object it is about, following the precedent set by
-- `gate_results.passed` in 0006, where a column comment is a tested contract
-- rather than decoration.
--
-- The hazard restated: the global daily ceiling (src/repo/spend.ts,
-- readSpendFailClosed) sums cost_micros across ALL users for the current UTC
-- day. Under forced RLS with a per-user policy that sum silently returns only
-- the caller's own rows, the account-wide total reads far below the cap, and
-- the ceiling that exists to stop the whole system spending unbounded money in
-- a day stops firing — with no error and no failing test, because an
-- under-count is indistinguishable from a legitimately small total.
comment on table daily_usage is
  'Per-user, per-UTC-day cost ledger. NOT an ordinary per-user table: the global '
  'daily ceiling (src/repo/spend.ts, readSpendFailClosed) sums cost_micros across '
  'ALL users for the current UTC day. BEFORE attaching any RLS policy here, read '
  'this -- under `force row level security` with a per-user policy that sum returns '
  'only the caller''s own rows, the account-wide total reads far below the cap, and '
  'the ceiling that stops the whole system spending unbounded money in a day simply '
  'stops firing. It fails SILENTLY: no error, no failing test, because an '
  'under-count is indistinguishable from a legitimately small total. That sum must '
  'stay owner-visible (or run as a `bypassrls` role), or move to a maintained '
  'per-day counter, before any policy is attached. See migration 0003 for the '
  'fuller note.';
