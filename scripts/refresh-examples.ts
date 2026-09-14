/**
 * npm run examples -- <user id>
 *
 * Prints the examples file for one traveller to stdout. It does NOT write
 * src/desks/examples/planning.md, and that is the decision this whole module
 * turns on: the loop selects and proposes, and a commit changes behaviour.
 *
 *   npm run examples -- <user id> > src/desks/examples/planning.md
 *
 * is the second half, and a person types it, reads the diff, and signs it. An
 * example set that refreshed itself at run time would make
 * course.model_calls.prompt_version a lie on every row it stamped, and
 * prompt_version is what lesson 7.5's release canary splits traffic on and what
 * lesson 5.6's drift canary pins.
 */
import 'dotenv/config'
import { config } from 'dotenv'
import { connect } from '../src/db.js'
import { renderExamples, selectExamples } from '../src/loop/examples.js'
import type { Difficulty } from '../src/loop/difficulty.js'

config({ path: '.env.local', override: false })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}
const userId = process.argv[2]
if (!userId) {
  console.error('Usage: npm run examples -- <user id>')
  process.exit(1)
}

const sql = connect(process.env.DATABASE_URL, 1)
try {
  const difficulties: Difficulty[] = ['simple', 'complex']
  const sections = []
  for (const difficulty of difficulties) {
    sections.push({ difficulty, examples: await selectExamples(sql, { userId, difficulty }) })
  }
  process.stdout.write(renderExamples(sections, new Date().toISOString()))
} finally {
  await sql.end({ timeout: 5 })
}
