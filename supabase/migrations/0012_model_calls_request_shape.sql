-- Section 7 makes driver rows always capture_policy='full' "because they are the
-- eval corpus part 3 reads and the fine-tuning corpus part 4 reads", and the
-- drift section adds: "We also record the full request shape, because a silent
-- provider-side change to a default is now as likely a drift vector as a weights
-- change."
--
-- Neither was true. What was stored was the raw system string and the last thing
-- SHE said, so on step 3 of a multi-step turn `user_prompt` was still her opening
-- message and the assembled request -- transcript, folded-in tool results,
-- notebook suffix, cache breakpoints -- was captured nowhere. Recorded as
-- backlog 2.3.
--
-- Nullable, with no backfill: rows written before this migration cannot be
-- repaired, because the request they describe was never durable anywhere else
-- either. NULL here means "written before request capture existed" and is
-- distinguishable from a row that recorded a request. Reading it as "no request"
-- would be wrong; every consumer must treat NULL as unknown.

alter table model_calls add column request_shape jsonb;
