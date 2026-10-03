import { describe, it, expect } from 'vitest'
import { withTestDb } from './helpers/db.js'

describe('migration 0018', () => {
  it('accepts results and choices message roles and the three Jev seats', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id, status) values (gen_random_uuid(), 'active') returning id, user_id`
      for (const role of ['results', 'choices']) {
        const [m] = await sql`insert into messages (conversation_id, user_id, role, content) values (${c!.id}, ${c!.user_id}, ${role}, '{}') returning role`
        expect(m!.role).toBe(role)
      }
      // The live project also hosts an unrelated `course` schema with its own
      // same-named `model_calls`/`model_calls_seat_check` — `conname` alone is
      // ambiguous across schemas, so this is scoped to `public.model_calls`.
      const [q] = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'model_calls_seat_check' and conrelid = 'public.model_calls'::regclass`
      expect(q!.def).toContain("'intake'")
      expect(q!.def).toContain("'rerank'")
      expect(q!.def).toContain("'router'")
    })
  })
})
