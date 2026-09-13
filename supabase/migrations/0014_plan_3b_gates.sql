-- Plan 3b. Two additions, both spec-driven.
--
-- 1. proposals.parent_proposal_id. Spec 3b ruling: a revision is a NEW proposal
--    row, never a mutation of the one she saw, so the accepted snapshot and the
--    shipped itinerary cannot diverge. `on delete set null`: losing the parent
--    must not cascade-delete a child she may already have accepted.
--
-- 2. escalations. Spec section 4: "fixed-format (ids + enum reason codes, no
--    model free text), rate-limited per user per day". The check constraint IS
--    the "no free text" rule; the (user_id, created_at) index serves the daily
--    count. notified_at stays null until a Notifier confirms delivery, so a
--    recorded-but-unsent escalation is distinguishable from a sent one.

alter table proposals
  add column parent_proposal_id uuid references proposals(id) on delete set null;
create index proposals_by_parent on proposals (parent_proposal_id)
  where parent_proposal_id is not null;

create table escalations (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id         uuid not null,
  turn_id         uuid references turns(id) on delete set null,
  proposal_id     uuid references proposals(id) on delete set null,
  reason          text not null check (reason in
                    ('supplier_unavailable','price_moved','user_request','safety','cannot_satisfy')),
  created_at      timestamptz not null default now(),
  notified_at     timestamptz,
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade
);
create index escalations_by_user_day on escalations (user_id, created_at desc);
create index escalations_by_conversation on escalations (conversation_id);
-- §6 / migration 0008's audit: every FK child column needs its own index
-- (leading column), or it joins agent_events.turn_id and messages.turn_id as
-- an unindexed regression that test/schema-corpus.test.ts's whole-catalogue
-- check would then have to re-flag.
create index escalations_by_turn on escalations (turn_id);
create index escalations_by_proposal on escalations (proposal_id);

revoke all on escalations from anon, authenticated;
alter table escalations enable row level security;
