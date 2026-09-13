-- The notebook as it STOOD when the gates judged this proposal, never as it
-- stands now.
--
-- 0013 left this out on purpose and named the reader it was waiting for: "the
-- eval replay is module 6". This is that reader. Replaying a gate needs the
-- constraints the gate had, and course.conversations.requirements is a single
-- jsonb column that update_requirements overwrites in place (0015), so the
-- state a gate ran against survives exactly until she changes her mind. She
-- sets a budget of 750 EUR, the budget gate refuses an 840 EUR stay, she raises
-- the budget, and a replay of that same gate then PASSES the offer production
-- rejected. The eval and the production check stop being the same check,
-- silently, in the direction that makes the evals look green.
--
-- UNBACKFILLABLE, and that is the reason this column arrives before anything
-- reads it rather than after. Every prior notebook state is gone: there is no
-- history table, no audit trail and no jsonb diff anywhere in this schema, so
-- rows written before this migration can never be given a true value and are
-- left null. A null here means "written before the snapshot existed", which is
-- a fact. Any value we invented would be a guess wearing a fact's clothes.
--
-- Shaped exactly like course.conversations.requirements, so one reader
-- (fromStored, src/notebook.ts) reads both. A second shape would be a
-- second parser, and two parsers of one format is how the two disagree.
alter table course.proposals add column requirements_snapshot jsonb;

comment on column course.proposals.requirements_snapshot is
  'The notebook as it stood when the gates approved this proposal, in the same '
  'jsonb shape as course.conversations.requirements. Null on rows written before '
  'migration 0018: the prior notebook states were overwritten in place and cannot '
  'be recovered. Read this and never the live notebook when replaying a gate.';
