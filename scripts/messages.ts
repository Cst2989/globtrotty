import 'dotenv/config'
import { config } from 'dotenv'
import { connect } from '../src/db.js'

config({ path: '.env.local', override: false })

const sql = connect(process.env.DATABASE_URL!, 1)
try {
  const rows = await sql`
    select role, left(content, 90) as content, created_at
      from course.messages order by seq desc limit 10`
  for (const row of rows) {
    console.log(`${row.created_at.toISOString()}  ${row.role.padEnd(5)}  ${row.content}`)
  }
  if (rows.length === 0) console.log('no messages yet')
} finally {
  await sql.end({ timeout: 5 })
}
