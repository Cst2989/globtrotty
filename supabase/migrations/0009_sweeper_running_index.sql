-- The sweeper's `running` arm now judges silence by coalesce(heartbeat_at,
-- queued_at), the same expression claimTurn's own stale arm uses (0004's
-- turns_sweeper is built on it too). It compared bare heartbeat_at from lesson
-- 3.5 until lesson 3.7's whole-branch review, and 0008's turns_sweeper_running
-- was keyed to match that comparison: a b-tree on the bare column cannot serve
-- a predicate on the expression, so the index would sit there being maintained
-- on every write and answering nothing.
--
-- Dropped and recreated under its own name rather than left beside a second
-- index, because there is only one question to answer here and two indexes for
-- it would be two things to keep true. 0008 is not edited: an applied migration
-- is history, and this file is what the database now has.
drop index if exists course.turns_sweeper_running;
create index turns_sweeper_running
  on course.turns (coalesce(heartbeat_at, queued_at)) where status = 'running';
