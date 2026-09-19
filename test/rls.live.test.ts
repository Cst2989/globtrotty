/**
 * Plan 4a, Task 9. Migration 0016 (`supabase/migrations/0016_plan_4_chat.sql`)
 * granted `authenticated` SELECT, filtered by `user_id = auth.uid()` (or, for
 * `gate_results`, by an EXISTS join through `conversations`), on nine
 * tables: conversations, messages, turns, proposals, link_clicks,
 * agent_events, escalations, tool_results, gate_results. It granted nothing
 * at all on daily_usage, model_calls, canary_runs, drift_alarms, conversions,
 * tool_calls — those keep the blanket `revoke all … from anon, authenticated`
 * from migration 0003/0004.
 *
 * THIS is the only test that proves those policies actually isolate two
 * signed-in travellers from each other. Every other DB test in this repo
 * runs on the OWNER connection (`postgres(DATABASE_URL)`, or
 * `test/helpers/db.ts`'s `withTestDb`), which bypasses RLS entirely — RLS is
 * enabled but never FORCED (see 0003's own doc comment on why: the worker
 * and the sweeper connect as the owner and must keep seeing every row,
 * including the global daily ceiling's cross-user sum). A unit test against
 * the owner connection cannot tell a real per-row policy from a typo'd one
 * that happens to let the owner through anyway — only a real anon-key HTTP
 * round trip against the live PostgREST endpoint, signed in as two distinct
 * `auth.users`, can.
 *
 * That's what makes this test different from every other one in the suite,
 * and why it is gated rather than run by default:
 *
 *   - It talks to the live Supabase project over HTTPS (PostgREST + GoTrue),
 *     not the local/CI Postgres container `DATABASE_URL` usually points at
 *     for other tests — `SUPABASE_URL`/`SUPABASE_ANON_KEY` are the actual
 *     hosted project's REST endpoint and anon key.
 *   - It creates and deletes two real `auth.users` rows with
 *     `SUPABASE_SERVICE_ROLE_KEY`, which no other test in this repo uses (the
 *     app itself never imports that key — see common.md's global
 *     constraints) and which is deliberately not exercised on every run.
 *   - It NEEDS the project's email+password sign-in provider enabled (the
 *     Supabase default) — `auth.signInWithPassword` fails outright if it
 *     is not, and there is nothing this test can do about that from here.
 *
 * Seeding uses the OWNER Postgres connection directly (`postgres(DATABASE_URL)`,
 * a plain client with no explicit transaction — NOT `withTestDb`, which wraps
 * everything in a transaction that is always rolled back). The anon-client
 * reads below happen over HTTP, in a separate Postgres session PostgREST
 * opens itself; a seed left uncommitted in a rolled-back transaction would
 * never be visible to that session at all, and every "0 rows" assertion
 * would pass for the wrong reason. Cleanup runs in a `finally`: delete every
 * conversation id this run created (A's seeded one and B's discriminator
 * one, tracked in `createdConversationIds` as each insert resolves, not only
 * once a whole seed succeeds — a later insert in the same seed can still
 * throw, and that conversation must not be orphaned; every child row
 * cascades from its conversation — see the FKs in migrations 0001/0004/0014),
 * then `auth.admin.deleteUser` both users.
 *
 * Run it explicitly, once, before relying on it:
 *
 *   LIVE_SUPABASE=1 pnpm vitest run test/rls.live.test.ts
 *
 * `pnpm test` (no `LIVE_SUPABASE`) skips this whole file via `describe.skip`
 * — it never runs as part of the ordinary suite or CI, both to avoid
 * creating/deleting real auth users on every push and because a transient
 * network hiccup against the live project must not fail a routine build.
 *
 * The "break" this test is built to catch: `drop policy own_messages on
 * messages` (or any other live-project schema mutation) is not something
 * this test can safely do against the shared hosted project — there is no
 * throwaway transaction across an HTTP round trip through PostgREST. Instead
 * the test carries its OWN discriminator: after confirming user B sees zero
 * rows on every granted table (which a blanket "deny everyone" policy would
 * also produce), it seeds a SECOND conversation owned by B and asserts B now
 * sees EXACTLY that one row. A blanket-deny policy would fail that second
 * assertion (B would see 0 rows, not 1); a policy that filters on the wrong
 * column, or not at all, would fail the FIRST set of assertions (B would see
 * A's rows too). Only a policy that correctly filters on `user_id = auth.uid()`
 * passes both.
 */
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'

const RUN_LIVE = process.env.LIVE_SUPABASE === '1'
const describeLive = RUN_LIVE ? describe : describe.skip

// Migration 0016's exact grant list.
const GRANTED_TABLES = [
  'conversations', 'messages', 'turns', 'proposals', 'link_clicks',
  'agent_events', 'escalations', 'tool_results', 'gate_results',
] as const

// Tables with RLS enabled (0003/0004) and NO grant to `authenticated` at
// all — selecting is refused at the privilege level, before any policy (or
// its absence) is even consulted. All six of migration 0016's ungranted
// tables (see the file header above), not just two.
const DENIED_TABLES = [
  'daily_usage', 'model_calls', 'canary_runs', 'drift_alarms', 'conversions', 'tool_calls',
] as const

type SeededRows = {
  conversationId: string
  messageId: string
  turnId: string
  proposalId: string
  linkClickId: string
  toolResultId: string
  gateResultId: string
  agentEventId: string
  escalationId: string
}

/**
 * One row in every granted table, owned by `userId`. Owner connection;
 * commits immediately (no transaction) — each `insert` below is visible,
 * and orphanable, the moment it resolves.
 *
 * `createdConversationIds` is pushed the moment the `conversations` insert
 * itself resolves, BEFORE any of the eight inserts that follow (which all
 * hang off that same conversation id) get a chance to throw. Without this,
 * a `finally` that only knew about a fully-populated `SeededRows` (returned
 * only after every insert below succeeds) would skip cleanup entirely on a
 * partial-seed failure, orphaning the conversation — and every child row
 * already inserted before the throw — in the shared hosted project;
 * `conversations.user_id` has no FK to `auth.users`, so
 * `auth.admin.deleteUser` does not cascade and clean it up either.
 */
async function seedGrantedTables(
  sql: postgres.Sql, userId: string, createdConversationIds: string[],
): Promise<SeededRows> {
  const tag = randomUUID()

  const [conv] = await sql<{ id: string }[]>`
    insert into conversations (user_id) values (${userId}) returning id`
  const conversationId = conv!.id
  createdConversationIds.push(conversationId)

  const [turn] = await sql<{ id: string }[]>`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${conversationId}, ${userId}, ${`rls-live-${tag}`}, 'done')
    returning id`
  const turnId = turn!.id

  const [message] = await sql<{ id: string }[]>`
    insert into messages (conversation_id, user_id, turn_id, role, content)
    values (${conversationId}, ${userId}, ${turnId}, 'user', 'a week in Lisbon, September')
    returning id`
  const messageId = message!.id

  const [proposal] = await sql<{ id: string }[]>`
    insert into proposals (conversation_id, user_id, turn_id, itinerary, requirements_snapshot,
      total_minor, currency, gate_outcome)
    values (${conversationId}, ${userId}, ${turnId}, ${sql.json({ schemaVersion: 1, items: [] })},
      ${sql.json({})}, 100000, 'EUR', 'approved')
    returning id`
  const proposalId = proposal!.id

  const [linkClick] = await sql<{ id: string }[]>`
    insert into link_clicks (proposal_id, turn_id, user_id, item_id, supplier, url,
      tracking_ref, quoted_minor, currency)
    values (${proposalId}, ${turnId}, ${userId}, 'hotel-1', 'mock', 'https://example.com/book',
      ${`rls-live-${tag}`}, 100000, 'EUR')
    returning id`
  const linkClickId = linkClick!.id

  const [toolResult] = await sql<{ id: string }[]>`
    insert into tool_results (conversation_id, user_id, turn_id, source_id, supplier, kind, name,
      price_minor, currency, price_basis, payload, ttl_seconds)
    values (${conversationId}, ${userId}, ${turnId}, ${`rls-live-src-${tag}`}, 'mock', 'hotel', 'RLS Test Hotel',
      100000, 'EUR', 'total', ${sql.json({})}, 3600)
    returning id`
  const toolResultId = toolResult!.id

  const [gateResult] = await sql<{ id: string }[]>`
    insert into gate_results (proposal_id, conversation_id, turn_id, gate, passed)
    values (${proposalId}, ${conversationId}, ${turnId}, 'provenance', true)
    returning id`
  const gateResultId = gateResult!.id

  const [agentEvent] = await sql<{ id: string }[]>`
    insert into agent_events (conversation_id, user_id, turn_id, kind, payload)
    values (${conversationId}, ${userId}, ${turnId}, 'tool_start', ${sql.json({})})
    returning id`
  const agentEventId = agentEvent!.id

  const [escalation] = await sql<{ id: string }[]>`
    insert into escalations (conversation_id, user_id, turn_id, proposal_id, reason)
    values (${conversationId}, ${userId}, ${turnId}, ${proposalId}, 'user_request')
    returning id`
  const escalationId = escalation!.id

  return {
    conversationId, messageId, turnId, proposalId, linkClickId,
    toolResultId, gateResultId, agentEventId, escalationId,
  }
}

/** `id`s an anon client can currently read back from `table`, or the PostgrestError message on failure. */
async function selectIds(
  client: SupabaseClient, table: string,
): Promise<{ ids: string[]; errorMessage: string | null }> {
  const { data, error } = await client.from(table).select('id')
  if (error) return { ids: [], errorMessage: error.message }
  return { ids: (data ?? []).map((row) => (row as { id: string }).id), errorMessage: null }
}

describeLive('RLS: two-user isolation against the live Supabase project (migration 0016)', () => {
  it(
    "B sees none of A's rows, A sees her own, both are refused on ungranted tables, and B's own row IS visible once seeded",
    async () => {
      const {
        SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL,
      } = process.env as Record<string, string | undefined>
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
        throw new Error(
          'rls.live.test.ts requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ' +
          'and DATABASE_URL (from .env.local) even with LIVE_SUPABASE=1',
        )
      }

      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      const ownerSql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })

      const stamp = Date.now()
      const emailA = `rls-a-${stamp}@example.com`
      const emailB = `rls-b-${stamp}@example.com`
      const password = `${randomUUID()}Aa1!`

      let userIdA: string | null = null
      let userIdB: string | null = null
      let seedA: SeededRows | null = null
      let discriminatorConversationId: string | null = null
      // Every conversation id created below, pushed the moment its insert
      // resolves — not only once a full `SeededRows` (or the discriminator
      // insert) succeeds. See seedGrantedTables' doc comment for why: this
      // is what lets `finally` clean up a conversation (and its cascaded
      // children) even when a LATER insert in the same seed throws.
      const createdConversationIds: string[] = []

      try {
        // --- Setup: two real auth.users, one seeded conversation for A ---
        const { data: dataA, error: errA } = await admin.auth.admin.createUser({
          email: emailA, password, email_confirm: true,
        })
        if (errA || !dataA.user) throw new Error(`auth.admin.createUser(A) failed: ${errA?.message}`)
        userIdA = dataA.user.id

        const { data: dataB, error: errB } = await admin.auth.admin.createUser({
          email: emailB, password, email_confirm: true,
        })
        if (errB || !dataB.user) throw new Error(`auth.admin.createUser(B) failed: ${errB?.message}`)
        userIdB = dataB.user.id

        seedA = await seedGrantedTables(ownerSql, userIdA, createdConversationIds)

        // --- Sign in as both, over the anon key — real HTTP, real GoTrue sessions ---
        const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        const { error: signInErrA } = await clientA.auth.signInWithPassword({ email: emailA, password })
        if (signInErrA) {
          throw new Error(
            `signInWithPassword(A) failed — if this names the email provider as disabled, that is a ` +
            `project configuration gap, not a bug in migration 0016's policies: ${signInErrA.message}`,
          )
        }

        const clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        const { error: signInErrB } = await clientB.auth.signInWithPassword({ email: emailB, password })
        if (signInErrB) {
          throw new Error(`signInWithPassword(B) failed: ${signInErrB.message}`)
        }

        // --- B sees NOTHING of A's data on every granted table ---
        for (const table of GRANTED_TABLES) {
          const { ids, errorMessage } = await selectIds(clientB, table)
          expect(errorMessage, `B's select on ${table} should not error`).toBeNull()
          expect(ids, `B should see 0 rows on ${table} (A's seeded data)`).toEqual([])
        }

        // --- A sees her own row on every granted table ---
        const expectedIdByTable: Record<(typeof GRANTED_TABLES)[number], string> = {
          conversations: seedA.conversationId,
          messages: seedA.messageId,
          turns: seedA.turnId,
          proposals: seedA.proposalId,
          link_clicks: seedA.linkClickId,
          agent_events: seedA.agentEventId,
          escalations: seedA.escalationId,
          tool_results: seedA.toolResultId,
          gate_results: seedA.gateResultId,
        }
        for (const table of GRANTED_TABLES) {
          const { ids, errorMessage } = await selectIds(clientA, table)
          expect(errorMessage, `A's select on ${table} should not error`).toBeNull()
          expect(ids, `A should see exactly her own row on ${table}`).toEqual([expectedIdByTable[table]])
        }

        // --- Both are refused outright (no grant at all) on the ungranted tables ---
        // `select('*')`, not `select('id')`: `daily_usage` has no `id` column at
        // all (its PK is the composite `(user_id, day)` — see 0001_harness.sql),
        // and PostgREST resolves the column list against its schema cache before
        // it even reaches the privilege check, so `select('id')` there fails with
        // "column daily_usage.id does not exist" — a real error, but the wrong
        // one, and not proof of anything about the grant this assertion exists
        // to check. `select('*')` needs no column to exist up front and is
        // refused on privileges alone, for all six tables, the same way.
        for (const client of [clientA, clientB]) {
          for (const table of DENIED_TABLES) {
            const { error } = await client.from(table).select('*')
            expect(error, `select on ${table} should error (no grant)`).not.toBeNull()
            expect(error!.message).toMatch(/permission denied/i)
          }
        }

        // --- Discriminator: a conversation seeded under B's id IS visible to B ---
        // Proves the policy filters on user_id (B sees her own row) rather than
        // denying every row outright (which the "0 rows" checks above alone
        // cannot distinguish from a correct per-user filter).
        const [discRow] = await ownerSql<{ id: string }[]>`
          insert into conversations (user_id) values (${userIdB}) returning id`
        discriminatorConversationId = discRow!.id
        createdConversationIds.push(discriminatorConversationId)

        const { ids: bConversationIds, errorMessage: bConvError } = await selectIds(clientB, 'conversations')
        expect(bConvError).toBeNull()
        expect(bConversationIds).toEqual([discriminatorConversationId])
      } finally {
        // Cleanup, best-effort but every step attempted even if an earlier one fails.
        // Deletes by `createdConversationIds`, not by `seedA`/
        // `discriminatorConversationId` alone — those two are only set once
        // their WHOLE seed (nine inserts, or the one-row discriminator
        // insert) succeeds, so on a partial-seed throw (see
        // seedGrantedTables' doc comment) they would still be `null` here
        // and cleanup would skip the very conversation (and its cascaded
        // children — the FKs in migrations 0001/0004/0014) that failure
        // left behind. `createdConversationIds` is pushed to at insert time,
        // before any later insert in the same seed gets a chance to throw,
        // so every conversation this test created — fully seeded or not —
        // is deleted here.
        for (const id of createdConversationIds) {
          try {
            await ownerSql`delete from conversations where id = ${id}`
          } catch { /* already gone, or setup never got this far */ }
        }
        try {
          if (userIdA) await admin.auth.admin.deleteUser(userIdA)
        } catch { /* best-effort */ }
        try {
          if (userIdB) await admin.auth.admin.deleteUser(userIdB)
        } catch { /* best-effort */ }
        await ownerSql.end({ timeout: 5 })
      }
    },
    60_000,
  )
})
