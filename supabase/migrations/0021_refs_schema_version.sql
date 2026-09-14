-- What shape course.proposals.refs was written in.
--
-- The cheapest of the four defences P4 names against the inversion bug, and the
-- only one that catches it at the first row rather than at the first person who
-- asks why a number looks odd. The similarity function compares what we
-- proposed against what she booked. Both sides read refs. A refactor that
-- narrows what refs holds makes those two comparable-looking and not
-- comparable, and every test written against the narrow shape stays green,
-- because a fixture is written against what the code writes today.
--
-- An integer written at save time turns that into a loud mismatch:
-- assertComparableShape (src/loop/similarity.ts) refuses a row whose version is
-- not the one it was written for, and names both numbers in the message.
--
-- NOT NULL with a default of 1, and the default is a claim this file has to
-- stand behind: every row written before this migration carries
-- {sourceId, quantity, slot} per item, because ProposalRefsSchema has validated
-- exactly that shape since 0013 and src/repo/proposals.ts is the only writer of
-- this table (test/writers.test.ts, lesson 7.1). So 1 is the truth about the
-- old rows rather than a convenient fill.
--
-- SPEC section 6 calls this column itinerary_schema_version, on a proposals
-- table that carries a rehydrated itinerary. This branch has no itinerary
-- column and will not grow one: 0013's comment says why, which is that the
-- cashier re-reads every price out of course.tool_results and re-quotes it, so
-- a stored itinerary would be a second copy of data that is allowed to move.
-- The version is named for the column it versions, because a column named for a
-- column this table does not have is the defect class LESSONS.md calls the worst
-- one on this branch.
alter table course.proposals
  add column refs_schema_version int not null default 1 check (refs_schema_version >= 1);

comment on column course.proposals.refs_schema_version is
  'The shape of refs at save time. 1 is {sourceId, quantity, slot} per item. Bump it in the '
  'same commit that changes what recordProposal writes, and the readers refuse the mismatch '
  'instead of comparing two different shapes.';
