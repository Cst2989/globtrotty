import type { Limits } from './engine.js'

/**
 * The one home for the SPEND ceilings and the two per-turn caps beside them.
 * Every tier that enforces one of these five numbers imports it from here rather
 * than redefining it: two consumers disagreeing about a money limit means one of
 * them is silently not enforcing what the other thinks it is.
 *
 * Five fields, and not every limit on the branch. Module 5 added several bounds
 * that each live beside the one thing they bound and have no second reader:
 * `ESCALATIONS_PER_DAY` (src/tools.ts), `SCOUT_MAX_CITIES` and
 * `SUPPLIER_CALL_COST` (src/tools/supplierBudget.ts), `MAX_BREAKPOINTS` and
 * `INTERMEDIATE_EVERY` (src/model/cache.ts), `DEFAULT_MEMORY_LIMIT` and
 * `MAX_SOURCE_FACTS_PER_KEY` (src/repo/memory.ts), `MAX_CARD_NAME_LEN`
 * (src/channel.ts), `MAX_STORED` and `TRUNCATE_ABOVE_BYTES`
 * (src/repo/model-calls.ts). What belongs here is a number two tiers could
 * disagree about, and what stays local is a number one function owns.
 */
export const DEFAULT_LIMITS: Limits = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50, across every user in one UTC day
  maxSteps: 12,                            // lesson 1.5's first guess, kept until a measurement replaces it
  maxSupplierCallsPerTurn: 6,              // two searches for flights, two for stays, two corrections
}

/**
 * The ceilings an eval run works under, which are not the ceilings production
 * works under.
 *
 * P3's nightly suite is twenty cases run three times, sixty conversations in
 * one night, and this branch carries three of those cases so far
 * (evals/golden-trips.json). Under DEFAULT_LIMITS those sixty conversations
 * would share one user's $15 day, the suite would stop somewhere in the middle
 * and stop somewhere else the next night, and a pass^k number computed over
 * whichever cases ran before the cap is a number nobody can read.
 *
 * Each eval conversation runs under its own randomUUID() user id
 * (src/evals/runner.ts), so the per-user daily ceiling below bounds ONE run of
 * one case rather than the night. That is a deliberate difference from main's
 * plan 3c, which mints one fixed OPS_USER_ID so its drift monitor spends the
 * whole night against a single reserved ops bucket. Minting a fresh id per run
 * costs the course exactly that bound and buys what an eval needs more: no
 * case can exhaust another's budget, and the gate rows on the card are that
 * case's own. The global ceiling is then the only real bound on a night, which
 * is the intent here rather than an oversight about the mechanism the product
 * uses.
 *
 * globalCeilingMicros is DELIBERATELY UNCHANGED. It is cross-user and per UTC
 * day, so raising it for the evals would raise it for her: the one ceiling that
 * stops this system spending unbounded money in a day would have been loosened
 * by a test suite. It still bounds the whole night, and a suite that trips it
 * has found a real fact about what it costs to run. That now includes lesson
 * 6.6's judge, which is not a conversation anybody talks to and reserves like
 * one anyway: `runJudge` (src/evals/judge.ts) reserves and reconciles against a
 * conversation the judge pass mints for itself, under this object, so all three
 * ceilings see it and there is still no fifth writer of the ledger.
 *
 * The conversation ceiling is tighter than production's rather than looser,
 * because an eval case that spends more than a real conversation is an eval
 * case that has stopped resembling the thing it measures. It is not as tight as
 * it can be made: the longest case on this branch, `no-for-1500-03`, spends
 * about $1.57 across its ninety-six model calls, and a ceiling of $2 stopped it
 * two model calls short of the end of its own recording. What stopped it was not
 * the spend, which never reached $2, but the RESERVATION: the driver reserves an
 * upper bound before every call (src/agents/driver.ts) and the last turn's
 * reservation was what crossed. $4 is chosen against that, so the case that
 * spends $1.57 keeps its headroom, and it is a ceiling a case would have to more
 * than double its spend to reach. A number that generous is not a cost control,
 * it is a runaway stop, and the cost control is the global ceiling below.
 *
 * There is no fifth writer of the ledger here and no second definition of any
 * number. An eval conversation reserves and reconciles through `reserve` and
 * `reconcile` (src/repo/reservation.ts) like every other conversation, and this
 * object changes what those functions compare against rather than who moves the
 * money.
 */
export const EVAL_LIMITS: Limits = {
  conversationCeilingMicros: 4_000_000n,   // $4, half of production's, per eval conversation
  dailyCeilingMicros: 4_000_000n,          // $4, and each eval run has its own user id, so this is per run
  globalCeilingMicros: DEFAULT_LIMITS.globalCeilingMicros,  // unchanged, and cross-user on purpose
  maxSteps: DEFAULT_LIMITS.maxSteps,
  maxSupplierCallsPerTurn: DEFAULT_LIMITS.maxSupplierCallsPerTurn,
}
