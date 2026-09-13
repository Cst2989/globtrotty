import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Who is typing. `facts` is everything she knows and will say if asked;
 * `refuses` is everything she will not agree to however it is put to her, which
 * is what makes the "not for 1,500 in August" case testable at all.
 */
export type Persona = {
  facts: Record<string, string | number | boolean>
  style: string
  refuses: string[]
}

const PersonaSchema = z.strictObject({
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  style: z.string().min(1),
  refuses: z.array(z.string()),
})

export const GoldenCaseSchema = z.strictObject({
  // Kebab case with a two-digit suffix, because lesson 6.4 seeds the supplier
  // world from this string and a case id that changes changes the world.
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*-\d{2}$/),
  firstMessage: z.string().min(1),
  persona: PersonaSchema,
  expect: z.strictObject({
    mustInclude: z.array(z.string()),
    minFrontierCalls: z.int().min(0),
    maxFrontierCalls: z.int().min(1),
    maxQuestionsAsked: z.int().min(0),
    proposals: z.int().min(0),
    gates: z.enum(['all pass', 'any fail']),
  }),
})

export const GoldenTripsSchema = z.array(GoldenCaseSchema).min(1)
export type GoldenCase = z.infer<typeof GoldenCaseSchema>

const DEFAULT_FILE = new URL('../../evals/golden-trips.json', import.meta.url)

/**
 * The recording each case replays against, by case id.
 *
 * One list and two readers, `evals/run.ts` and `test/eval-run.test.ts`, for the
 * reason every other pinned set in this branch has one home: a fixture renamed
 * in one of them and not the other is a case that throws at load and lands in
 * `casesExpected` without ever running. A case with no entry here is a case
 * nothing can replay, which is why `fixtureFor` refuses rather than returning
 * undefined for `replayClient` to turn into a missing-file error two frames
 * later.
 */
const FIXTURES: Record<string, string> = {
  'portugal-toddler-01': 'eval-portugal-toddler',
  'hotel-only-02': 'eval-hotel-only',
  'no-for-1500-03': 'eval-no-for-1500',
}

export function fixtureFor(caseId: string): string {
  const name = FIXTURES[caseId]
  if (!name) {
    throw new Error(
      `No recording for case ${caseId}. Every golden case needs one: record it with `
      + 'RECORD_MODEL=1 and a key, then name it in FIXTURES (src/evals/cases.ts).',
    )
  }
  return name
}

/**
 * The cases, parsed rather than cast.
 *
 * A golden case is the fixed input a whole suite's numbers are compared
 * against, so a typo in it does not fail loudly, it quietly moves the thing
 * being measured. `strictObject` refuses an unknown key for that reason: a
 * `maxFrontierCall` singular would otherwise be read as absent, the default
 * would apply, and the case would keep passing while testing something else.
 */
export function loadGoldenCases(file: string | URL = DEFAULT_FILE): GoldenCase[] {
  return GoldenTripsSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}
