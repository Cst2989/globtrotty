-- What one turn cost, on the turn itself. course.conversations.spend_usd_micros
-- (0003) is the running total a ceiling reads and is written only by
-- recordSpend; this column answers a different question, "what did THIS turn
-- spend", which a conversation total cannot answer once she has had three of
-- them. It is written by completeTurn and failTurn, so a turn that stopped at a
-- ceiling records what it spent getting there rather than reading as free.
alter table course.turns
  add column spend_usd_micros bigint not null default 0 check (spend_usd_micros >= 0);
