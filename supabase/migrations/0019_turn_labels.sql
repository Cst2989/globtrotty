-- What one turn did, counted at the moment it finished.
--
-- SPEC section 7: derived labels that outlive the 90-day window are extracted
-- at write time, routing labels and per-turn trajectory counters, because part
-- 3 wants trends and part 4 wants a fine-tuning corpus, and both die at 90 days
-- otherwise. Every number in this table can be recomputed from
-- course.model_calls, course.messages and course.tool_results TODAY, and none
-- of them can be recomputed once those rows are trimmed. That is the whole
-- argument for the table: it is not a cache, it is the only copy that survives.
--
-- One row per turn, and the turn id is the primary key rather than a surrogate,
-- because a turn has exactly one shape and a second row for one turn would be
-- two answers to a question with one.
--
-- A turn with NO row here is a fact and not a gap to paper over: it means the
-- label write did not happen, which is distinguishable from a turn that did
-- nothing, and lesson 6.5's rates count both denominators. That distinction is
-- the same one part 2 bought for traces and is why "92% pass" can be read at
-- all.
create table course.turn_labels (
  turn_id         uuid primary key references course.turns(id) on delete cascade,
  -- The write order, and the only thing anything sorts by. Same reasoning as
  -- course.messages.seq in 0001.
  seq             bigint generated always as identity,
  conversation_id uuid not null,
  -- Carried for the reason every child table in this schema carries it: the
  -- pair is what the composite foreign key below checks, so a label row can
  -- never be attached to another user's conversation, and a user's rows can be
  -- deleted by user id alone the way test/helpers/db.ts deletes every other
  -- table's.
  user_id         uuid not null,
  tool_calls      int not null check (tool_calls >= 0),
  questions_asked int not null check (questions_asked >= 0),
  -- Money spent before the first question was asked, counted in searches. A
  -- discovery conversation that fires searches before its first ask_user is
  -- guessing at a budget nobody stated.
  searches_before_first_question int not null check (searches_before_first_question >= 0),
  prices_quoted   int not null check (prices_quoted >= 0),
  -- Prices in prose with no tool result behind them, in this conversation. The
  -- numerator of the provenance rate, kept beside its denominator so a trend
  -- reads without a join.
  unbacked_prices int not null check (unbacked_prices >= 0),
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade,
  -- An unbacked price is a price, so the numerator can never exceed its own
  -- denominator. A rate over 100 percent is the shape of a counting bug and
  -- this refuses to store one.
  constraint turn_labels_unbacked_within_quoted check (unbacked_prices <= prices_quoted)
);
create index turn_labels_by_conversation on course.turn_labels (conversation_id, seq desc);
