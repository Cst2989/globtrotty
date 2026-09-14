/**
 * npm run worst
 *
 * The weekly read. Thirty minutes with the conversations that went worst finds
 * what no metric names, and it is where next month's hypotheses come from.
 *
 * It prints ids and counts and NOT transcripts, which is the one design
 * decision in this file: a conversation is read by opening it, and a script
 * that dumped every message of the ten worst conversations into a terminal
 * would put a traveller's own words into a scrollback and into whatever
 * captures it, for a reader who has not decided to look at her yet.
 */
import 'dotenv/config'
import { config } from 'dotenv'
import { connect } from '../src/db.js'
import { renderWorst, worstConversations } from '../src/loop/worst.js'

config({ path: '.env.local', override: false })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

const sql = connect(process.env.DATABASE_URL, 1)
try {
  console.log(renderWorst(await worstConversations(sql, { limit: 10 })))
} finally {
  await sql.end({ timeout: 5 })
}
