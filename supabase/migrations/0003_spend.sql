-- Where a conversation's own spend accumulates. Added here rather than in 0001
-- because nothing could write it until there was a ledger.
alter table course.conversations
  add column spend_usd_micros bigint not null default 0 check (spend_usd_micros >= 0);

create table course.daily_usage (
  user_id     uuid not null,
  day         date not null,
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

-- The global daily ceiling runs `select sum(cost_micros) from course.daily_usage
-- where day = today` on every ceiling check, which is once per model call, on the
-- money critical path. The primary key has `day` second, so there is no usable
-- prefix for a day-only predicate and the query is a full scan of a table that
-- grows by one row per user per day forever. It is fast today because the table
-- is tiny; it gets linearly slower and never gets better.
--
-- Deliberately without `include (cost_micros)`. That would only pay off through
-- an index-only scan, which needs the pages marked all-visible, and the rows
-- this query reads are exactly today's, the ones being upserted all day long.
-- The read would fall back to the heap anyway, while the cost lands on the write
-- path: cost_micros is the column every spend record mutates, and carrying it in
-- an index means each increment has to maintain that index too.
create index daily_usage_day on course.daily_usage (day);
