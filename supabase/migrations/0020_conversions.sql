-- What she actually booked, reported back to us by somebody else.
--
-- Created EMPTY, and that is the decision rather than an accident. This product
-- hands off: course.link_clicks is the last row we write about a trip, and the
-- commission arrives days or months later from an affiliate network, keyed on
-- the sub-id we embedded in the outbound URL. SPEC section 6 says the join key
-- is what cannot be added later, and it is right in the strongest sense: a
-- network that reports a booking against a ref we never minted, or that we
-- minted and did not store, is a booking nobody can attribute to a proposal, a
-- prompt version or a traveller, and it cannot be reconstructed afterwards.
-- The minting shipped at lesson 4.6 (src/cashier.ts rule 5). This is the other
-- half, and it is worth creating before there is a single row to put in it,
-- because the alternative is discovering the join key is missing on the day the
-- first report arrives.
--
-- One row per reported booking, and the tracking ref is unique here as well as
-- in the parent, because a network that reports the same booking twice is
-- common and two rows for one booking would double every rate derived from
-- this table.
create table course.conversions (
  id              uuid primary key default gen_random_uuid(),
  -- The write order, and the only thing anything sorts by, for the reason
  -- course.messages.seq gives in 0001: every row a batch writes shares one
  -- transaction timestamp, so created_at cannot order anything.
  seq             bigint generated always as identity,
  -- The join key, and the whole reason this table can exist at all. Unique, for
  -- the reason 0013 makes it unique on the parent: a conversion we cannot
  -- resolve to exactly one click is a conversion nobody can attribute.
  -- Both foreign keys below cascade, and they have to agree: two references to
  -- one parent where only one cascades would leave a delete of a click blocked
  -- by the other, which is a constraint nobody wrote down deciding what a
  -- delete means.
  tracking_ref    text not null unique
                  references course.link_clicks(tracking_ref) on delete cascade,
  -- The click row itself, carried beside the ref rather than re-joined. The ref
  -- is what the network sends and the id is what this schema uses, and keeping
  -- both means a reader never has to decide which of them to trust.
  link_click_id   uuid not null references course.link_clicks(id) on delete cascade,
  conversation_id uuid not null,
  -- Carried for the reason every child table in this schema carries it, and
  -- derived rather than accepted: src/repo/conversions.ts writes this row with
  -- an insert-select off the click, so the pair below comes out of
  -- course.link_clicks and course.proposals and never out of the feed. A feed
  -- that could name a user id could file a booking under somebody else.
  user_id         uuid not null,
  -- As the network reported it, which is not always what we recorded. Stored as
  -- reported and never coerced to the click's supplier: a disagreement is a
  -- fact about the feed, and a column that silently agreed with itself could
  -- not express one.
  supplier        text not null,
  booked_at       timestamptz not null,
  amount_minor    bigint not null check (amount_minor >= 0),
  currency        char(3) not null,
  -- What we earned, in the same currency as the amount above. One currency
  -- column and not two, exactly as SPEC section 6 writes it: every network this
  -- shape describes reports a commission in the currency of the booking, and a
  -- second column would be a column with no writer.
  commission_minor bigint not null check (commission_minor >= 0),
  -- When the network told us, which is not when she booked. Both are stored
  -- because the gap between them is the thing that makes this table hard: a
  -- rate computed over reported_at answers "what did we hear about this month"
  -- and a rate over booked_at answers "what happened this month", and those are
  -- different questions with different denominators.
  reported_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references course.conversations (id, user_id) on delete cascade
);
-- "What did this traveller book", the read src/repo/conversions.ts makes.
create index conversions_by_user on course.conversions (user_id, seq desc);
-- "What converted in this window", the read lesson 7.5 makes per prompt version.
create index conversions_by_booked_at on course.conversions (booked_at);
-- Found by the catalogue-wide audit in test/schema-corpus.test.ts, the same
-- audit that found course.model_calls.turn_id at 0013: neither index above
-- leads on a foreign-key child column, so link_click_id and conversation_id
-- each need one of their own, or a delete on either parent scans the whole of
-- this table looking for rows to cascade.
create index conversions_by_link_click on course.conversions (link_click_id);
create index conversions_by_conversation on course.conversions (conversation_id);

comment on table course.conversions is
  'Created empty in slice 1, on purpose. The rows arrive months after the click and the '
  'join key is what cannot be added later.';

-- No grant and no policy, and that is this file's second decision.
--
-- 0017 grants course_worker the eight tables a turn touches and grants nothing
-- at all to course.model_calls, course.daily_usage, course.tool_calls and
-- course.gate_results, on the argument that a table with a grant and no policy
-- is a table every course_worker session can read whole. This table belongs in
-- the second group. No worker path reads or writes it: a conversion arrives on
-- a reported feed, outside any turn, through the owner connection, the way the
-- ledger writes do. test/isolation.test.ts asserts a course_worker session
-- cannot reach it, one case, which is what makes this paragraph checkable
-- rather than merely stated.
