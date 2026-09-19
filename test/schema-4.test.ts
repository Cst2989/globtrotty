import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

const USER = '00000000-0000-4000-8000-00000000d401'

describeDb('0016 plan 4 schema', () => {
  it('accepts an action message and refuses an unknown role', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning id`
      const [m] = await sql`insert into messages (conversation_id, user_id, role, content)
        values (${c!.id}, ${USER}, 'action', ${JSON.stringify({ action: 'hand_off', proposalId: USER })}) returning role`
      expect(m!.role).toBe('action')
      await expect(sql.begin((tx) => tx`insert into messages (conversation_id, user_id, role, content) values (${c!.id}, ${USER}, 'system', 'x')`))
        .rejects.toThrow(/check constraint/i)
    })
  })
  it('accepts a screened agent event', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning id`
      const [e] = await sql`insert into agent_events (conversation_id, user_id, kind, payload) values (${c!.id}, ${USER}, 'screened', '{}') returning kind`
      expect(e!.kind).toBe('screened')
    })
  })
  it('grants authenticated select on the user-owned tables and nothing on the ledgers', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ table_name: string; privilege_type: string }[]>`
        select table_name, privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_schema = 'public' order by table_name`
      const granted = new Set(rows.map((r) => `${r.table_name}:${r.privilege_type}`))
      for (const t of ['conversations','messages','turns','proposals','link_clicks','agent_events','escalations','tool_results','gate_results']) {
        expect(granted.has(`${t}:SELECT`)).toBe(true)
      }
      for (const t of ['daily_usage','model_calls','canary_runs','drift_alarms','conversions','tool_calls']) {
        expect([...granted].some((g) => g.startsWith(`${t}:`))).toBe(false)
      }
      expect([...granted].some((g) => /:(INSERT|UPDATE|DELETE)$/.test(g))).toBe(false)
    })
  })
  it('has a policy on every granted table and none elsewhere', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ tablename: string; policyname: string; cmd: string; qual: string }[]>`
        select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public'`
      const byTable = new Map(rows.map((r) => [r.tablename, r]))
      for (const t of ['conversations','messages','turns','proposals','link_clicks','agent_events','escalations','tool_results','gate_results']) {
        expect(byTable.get(t)?.cmd).toBe('SELECT')
      }
      expect(byTable.has('daily_usage')).toBe(false)
      expect(byTable.has('model_calls')).toBe(false)
    })
  })
  /**
   * Migration 0017 (final review, I2). `screenReply` stores the withheld reply
   * verbatim in `agent_events.payload.original`; 0016's policy let the
   * traveller's own anon client read it back. The predicate — not just the
   * policy's existence — is what closes that, so it is pinned here: an
   * `agent_events` policy that drifts back to a bare `user_id = auth.uid()`
   * fails this test rather than silently re-opening the row.
   */
  it('hides screened agent events from the browser role', async () => {
    await withTestDb(async (sql) => {
      const [p] = await sql<{ qual: string }[]>`
        select qual from pg_policies
         where schemaname = 'public' and tablename = 'agent_events'
           and policyname = 'own_agent_events'`
      expect(p?.qual).toBe("((user_id = auth.uid()) AND (kind <> 'screened'::text))")
    })
  })
  it('does not force RLS anywhere', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ relname: string }[]>`
        select relname from pg_class where relnamespace = 'public'::regnamespace and relforcerowsecurity`
      expect(rows).toEqual([])
    })
  })
})
