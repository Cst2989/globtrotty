-- The seat check constraint has accepted two names since lesson 2.5, and module
-- 5 introduces six more. Dropping and re-adding the constraint is the whole of
-- the change: the column is text, the rows are untouched, and every row already
-- written keeps the name it was written with.
--
-- 'cheap' stays in the list forever. It is the name lesson 1.2 gave the Haiku
-- seat and rows carry it, so removing it would make those rows unreadable
-- against their own constraint and would lose the ability to ask what they were.
-- Lesson 5.3 adds 'front_desk' beside it rather than renaming it.
--
-- The other seven are the names the product's own seat table uses, added here
-- in one migration rather than one per lesson, so that a lesson which adds a
-- seat adds a line to src/seats.ts and nothing else. test/schema.test.ts asserts
-- that every SeatName the code can produce satisfies this constraint, so a seat
-- added without a name here fails the suite rather than an insert at 3am.
alter table course.model_calls drop constraint model_calls_seat_check;
alter table course.model_calls add constraint model_calls_seat_check
  check (seat in ('driver', 'cheap', 'front_desk', 'scout', 'reviewer',
                  'monitor', 'titler', 'sim_user'));

-- The configuration we INTENDED, beside the model we asked for and the model the
-- API echoed back. `response.model` returns the alias for an aliased model, and
-- claude-opus-5 is alias only, so model_returned reads identically before and
-- after a weights swap and cannot detect drift. model_config_id encodes model
-- plus effort plus max_tokens, so `group by model_config_id` separates the eras
-- and lesson 5.6's behavioural canary has something to pin against.
--
-- Nullable, with no default. Every row lesson 2.5 through 4.6 wrote was made
-- before seats carried these settings, and back-filling them would state a
-- configuration nobody recorded. A null here means "written before the seat
-- carried this", which is a fact; a default would be a guess.
alter table course.model_calls add column effort          text;
alter table course.model_calls add column max_tokens      int;
alter table course.model_calls add column model_config_id text;

comment on column course.model_calls.model_config_id is
  'The configuration we asked for, as model/effort/max_tokens. The drift anchor: '
  'model_returned echoes an alias and cannot tell one set of weights from the next.';

-- Deliberately NOT added here: request_id, capture_policy, system_prompt,
-- user_prompt, response, thinking_mode. Nothing in this lesson writes any of
-- them, and a column that exists and is never written is a column a reader
-- believes in. They arrive in 0017 with lesson 5.7, which is the lesson that
-- captures model input and output and therefore the lesson that has to redact
-- credentials out of it first.
