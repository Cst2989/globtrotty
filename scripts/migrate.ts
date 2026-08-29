import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import { config } from 'dotenv'
import { connect, SCHEMA } from '../src/db.js'

config({ path: '.env.local', override: false })

// Deliberately not loadEnv: applying migrations must work before anyone has an
// API key, and demanding one here would block the first thing a reader does.
const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
}

const dir = path.join(process.cwd(), 'supabase', 'migrations')
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

const sql = connect(url, 1)
try {
  // Nothing here leans on a search_path, so the schema is created explicitly and
  // every statement names it. The ledger of applied files lives beside the
  // tables it describes, in the same schema.
  await sql.unsafe(`create schema if not exists ${SCHEMA}`)
  await sql.unsafe(`create table if not exists ${SCHEMA}.schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`)

  const applied = new Set(
    (await sql`select filename from course.schema_migrations`).map((r) => r.filename as string),
  )

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`)
      continue
    }
    const text = readFileSync(path.join(dir, file), 'utf8')
    // One transaction per file: a migration that fails half way leaves nothing
    // behind, so re-running it starts from the same place every time.
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`insert into course.schema_migrations (filename) values (${file})`
    })
    console.log(`apply ${file}`)
  }
  console.log(`${files.length} migration file(s), ${files.length - applied.size} applied now`)
} finally {
  await sql.end({ timeout: 5 })
}
