-- `turns.fail_reason` had eight values, all of them written by plan 1's harness.
-- None of them can express what plan 3's model client will actually meet, so
-- src/worker.ts recorded every error as 'provider_down' -- a lie the sweeper and
-- any later dashboard would both believe, and the only reason a permanent 400
-- looked identical to a transient 429 on the way out.
--
-- Three values are added. Every existing value is kept, unchanged.
--
--   'refused'            A model refusal. `stop_reason: "refusal"` is an HTTP 200
--                        with a populated `stop_details.category`; it never throws.
--                        Code that only inspects exceptions reads it as a
--                        successful turn that produced no content and hands the
--                        user an empty answer with nothing recorded. It is not
--                        'provider_down' (nothing is down), not 'fetch_failed'
--                        (the fetch succeeded), and certainly not success.
--
--   'provider_rejected'  A PERMANENT request fault: 400 malformed, 401 bad key,
--                        403 not entitled, 404 unknown model. Distinct from
--                        'provider_down' on purpose, and this is the distinction
--                        the whole task exists for: 'provider_down' means "try
--                        again", and a fault that can never succeed recorded under
--                        that name tells an operator -- and any later dashboard --
--                        to wait for a provider to recover from a problem the
--                        provider does not have. One value covers all four
--                        statuses: the operator's fix differs, but what the
--                        harness should do -- never retry -- is identical.
--
--                        Note what this does NOT describe. Nothing retries a
--                        failed turn today: failTurn writes status = 'failed'
--                        (src/repo/turns.ts) and the sweeper only considers
--                        'queued' and 'running' rows (src/sweeper.ts), so every
--                        classified failure is terminal, before this migration and
--                        after it. The taxonomy exists so plan 3 can introduce
--                        retry DELIBERATELY, with the retryable/non-retryable
--                        split already recorded on the row.
--
--   'unclassified'       An error the classifier does not recognise. Recorded as
--                        itself rather than folded into 'provider_down', because
--                        there is no evidence the provider was involved: a
--                        TypeError in our own code lands here, as does worker.ts's
--                        own "'park' is not implemented" throw. A rising count of
--                        these says the classifier needs a new rule -- exactly the
--                        signal 'provider_down' would have hidden.
--
-- The values are mirrored by the `FailReason` union in src/engine.ts (and its
-- classifier-produced subset, `ClassifiedReason` in src/errors.ts). test/schema.test.ts
-- pins the two together in both directions at compile time, so a value added to
-- one without the other fails the build rather than the insert.
--
-- Drop-and-recreate under the same name Postgres already generated for the inline
-- column check in 0001 (`turns_fail_reason_check`, confirmed against the live
-- catalogue), so this migration is a widening of that one constraint rather than a
-- second constraint layered beside it. `if exists` so a database built from a
-- future squashed baseline does not break here.

alter table turns drop constraint if exists turns_fail_reason_check;

alter table turns add constraint turns_fail_reason_check
  check (fail_reason in ('provider_down','fetch_failed','limit_reached',
                         'step_cap','deadline_exceeded','crash_loop',
                         'fenced','stalled',
                         'refused','provider_rejected','unclassified'));
