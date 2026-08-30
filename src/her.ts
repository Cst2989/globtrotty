/** The one request the whole course follows. */
export const HER_MESSAGE =
  'We want a week in Portugal in the second half of September, flying from Berlin, ' +
  'two adults and a toddler of two, somewhere near a beach with a crib in the room. ' +
  'Our budget for flights and hotel together is 1,500 euros.'

/**
 * The user id `npm run trip` commits real rows for, so a reader can run it
 * without a login.
 *
 * It lives here rather than in the script because it is the id every database
 * test must NOT use: a test with this id shares rows with whatever a reader last
 * ran, and those rows outlive a rolled-back transaction for the rest of the UTC
 * day. Lesson 3.7 makes that a test.
 */
export const DEMO_USER = '11111111-1111-1111-1111-111111111111'

/**
 * The user id `npm run demo` commits and deletes rows for, deliberately
 * distinct from `DEMO_USER` above. The two scripts share a database, and
 * `npm run trip` is the one script in the course that calls a live model and
 * spends real dollars (`scripts/trip.ts`'s own comment); the demo's own
 * `cleanup()` deletes every row this id owns at both ends of its run, and a
 * shared id would delete a live conversation `npm run trip` had just paid
 * for. A reader can safely run both against the same `DATABASE_URL` because
 * of this line, not despite it.
 */
export const DEMO_SCRIPT_USER = '22222222-2222-2222-2222-222222222222'
