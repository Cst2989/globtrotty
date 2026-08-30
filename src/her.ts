/** The one request the whole course follows. */
export const HER_MESSAGE =
  'We want a week in Portugal in the second half of September, flying from Berlin, ' +
  'two adults and a toddler of two, somewhere near a beach with a crib in the room. ' +
  'Our budget for flights and hotel together is 1,500 euros.'

/**
 * The one user id the scripts commit real rows for, so a reader can run
 * `npm run trip` and `npm run demo` without a login.
 *
 * It lives here rather than in either script because it is the id every database
 * test must NOT use: a test with this id shares rows with whatever a reader last
 * ran, and those rows outlive a rolled-back transaction for the rest of the UTC
 * day. Lesson 3.7 makes that a test.
 */
export const DEMO_USER = '11111111-1111-1111-1111-111111111111'
