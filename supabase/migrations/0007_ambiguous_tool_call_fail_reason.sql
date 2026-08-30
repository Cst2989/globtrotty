-- 'ambiguous_tool_call' was borrowing 'fenced' before this migration, which
-- collapsed two conditions the sweeper (lesson 3.5) must handle oppositely: a
-- turn fenced by a live sibling needs no attention, and a turn stopped by a
-- tool call that ran and could not be recorded has an unknown effect outside
-- the system and needs a person. Mirrors src/engine.ts's FAIL_REASONS exactly,
-- the same rule 0004's version of this constraint followed; test/schema.test.ts
-- checks the two stay in lockstep.
alter table course.turns drop constraint turns_fail_reason_check;
alter table course.turns add constraint turns_fail_reason_check
  check (fail_reason in ('provider_down', 'fetch_failed', 'limit_reached',
                         'step_cap', 'deadline_exceeded', 'crash_loop',
                         'fenced', 'ambiguous_tool_call', 'stalled',
                         'refused', 'provider_rejected', 'unclassified'));
