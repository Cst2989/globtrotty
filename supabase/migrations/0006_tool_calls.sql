-- The intent ledger. A row appears here BEFORE its tool runs, which is the whole
-- mechanism: after the fact we can tell "never started" from "started and we do
-- not know how it ended", and those two need opposite responses.
create table course.tool_calls (
  turn_id    uuid not null references course.turns(id) on delete cascade,
  -- Derived from the tool call's POSITION in the turn (step and block index),
  -- never from the model's own toolu_ id. A resumed turn asks the model again
  -- and gets a fresh id back for the very same call, so an id taken from the
  -- reply could never recognise a call it had already made, and the ledger
  -- would report every replay as fresh.
  call_id    text not null,
  name       text not null,
  status     text not null check (status in ('pending', 'done')),
  -- The tool's own outcome, replayed verbatim to a resumed turn. jsonb, so a
  -- stored null is a real stored result and not an absent one.
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (turn_id, call_id)
);
