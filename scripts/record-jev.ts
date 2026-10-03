/**
 * Records one REAL Jev response to stdout, for a fixture under test/fixtures/jev/. Never prints
 * the key. Gated on LIVE_JEV=1, same convention as the live tests, even though this is a CLI
 * tool rather than a test.
 *
 *   LIVE_JEV=1 pnpm exec tsx scripts/record-jev.ts "<message>" [todayIso] > test/fixtures/jev/x.json
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })

import { placeCandidates, datePartCandidates, countCandidates } from '../src/intake/candidates.js'
import { buildIntakeQuestions } from '../src/intake/brief.js'
import { askJev } from '../src/jev/client.js'

if (process.env.LIVE_JEV !== '1') {
  console.error('LIVE_JEV is not "1" — refusing to spend a real Jev call. Set LIVE_JEV=1 to proceed.')
  process.exit(1)
}
const message = process.argv[2]
if (!message) {
  console.error('usage: record-jev.ts "<message>" [todayIso]')
  process.exit(1)
}
const apiKey = process.env.JEV_KEY
if (!apiKey) {
  console.error('JEV_KEY is not set in .env.local')
  process.exit(1)
}

const today = new Date(`${process.argv[3] ?? '2026-10-03'}T12:00:00Z`)
const candidates = { places: placeCandidates(message), dates: datePartCandidates(message), counts: countCandidates(message) }
const questions = buildIntakeQuestions(message, candidates, today)
const state = { message, today: today.toISOString().slice(0, 10), candidates }

const response = await askJev({ apiKey }, { state, questions })
process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
