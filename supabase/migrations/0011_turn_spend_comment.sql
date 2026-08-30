-- Comment-only. No data and no schema change.
--
-- 0005_turn_spend.sql says this column "is written by completeTurn and
-- failTurn". That was exhaustive at lesson 3.3 and stopped being so at lesson
-- 3.6, when releaseForContinuation started adding each continued attempt's
-- spend through the same column. A migration is byte-identical after the tag
-- that introduces it, so 0005 is not edited: a correction to an audit contract
-- arrives as a new migration the way a correction to code arrives as a new
-- commit, and the history stays readable in the order it happened.
--
-- Written now, in the lesson that creates course.tool_results, because that
-- table introduces a SECOND bigint that looks like money and is not the same
-- money, and the distinction is worth stating on the column somebody would
-- otherwise reach for.
comment on column course.turns.spend_usd_micros is
  'What THIS turn cost us, in USD micros, summed across every attempt. Written by '
  'three functions in src/repo/turns.ts, all of them with +=: completeTurn and '
  'failTurn, the two closers, at most one of which ever lands for a turn; and '
  'releaseForContinuation, once per continued attempt, which is why the closers add '
  'rather than assign. Distinct from course.conversations.spend_usd_micros, the '
  'running conversation total a ceiling reads, which only recordSpend writes. NEVER '
  'a supplier price: course.tool_results.price_minor is a traveller''s money in a '
  'supplier''s currency and this is ours in USD micros. Both are bigint and neither '
  'converts into the other.';
