// Plan 4a, Task 7, fix round 1 (Minor). `web/data.ts`'s two exported
// functions (`listConversations`, `loadThread`) need a real, authenticated,
// RLS-scoped Supabase client to test end-to-end — an owner-seeded
// conversation for user A can't be read back through a Supabase client
// acting as user B without a real session, which this test suite has no way
// to establish. So this tests the two PURE mappings those functions build
// on instead, no DB required: `toThreadView` (the action-row → UI-sentence
// mapping) and `firstMessagePerConversation` (the sidebar's first-line
// dedup rule).
import { describe, expect, it } from 'vitest'
import { toThreadView, firstMessagePerConversation, type ThreadMessage } from '../web/data.js'

const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444'

describe('toThreadView', () => {
  it('turns an action row into its plain-language sentence, never the JSON', () => {
    const content = JSON.stringify({ action: 'hand_off', proposalId: PROPOSAL_ID })
    const rows: ThreadMessage[] = [
      { id: 'm1', role: 'user', content: 'hi', created_at: 't1' },
      { id: 'm2', role: 'action', content, created_at: 't2' },
    ]

    const view = toThreadView(rows)

    expect(view[0]).toEqual(rows[0])
    expect(view[1]!.content).toBe('You accepted the proposal')
    expect(view[1]!.content).not.toContain(PROPOSAL_ID)
    expect(view[1]!.content).not.toContain('hand_off')
    expect(view[1]!.content).not.toContain('proposalId')
  })

  it('falls back to a fixed sentence for a malformed action row, never the raw text', () => {
    const rows: ThreadMessage[] = [{ id: 'm1', role: 'action', content: 'not json', created_at: 't1' }]

    const view = toThreadView(rows)

    expect(view[0]!.content).toBe('A card action was recorded')
    expect(view[0]!.content).not.toContain('not json')
  })

  it('leaves user and agent rows unchanged', () => {
    const rows: ThreadMessage[] = [
      { id: 'm1', role: 'user', content: 'a week in Lisbon', created_at: 't1' },
      { id: 'm2', role: 'agent', content: 'Sure — when do you want to travel?', created_at: 't2' },
    ]

    expect(toThreadView(rows)).toEqual(rows)
  })
})

describe('firstMessagePerConversation', () => {
  it('picks the first (earliest, given oldest-first input) user message per conversation', () => {
    const rows = [
      { conversation_id: 'c1', content: 'first for c1' },
      { conversation_id: 'c2', content: 'first for c2' },
      { conversation_id: 'c1', content: 'second for c1, must be ignored' },
    ]

    const map = firstMessagePerConversation(rows)

    expect(map.get('c1')).toBe('first for c1')
    expect(map.get('c2')).toBe('first for c2')
    expect(map.size).toBe(2)
  })

  it('returns an empty map for no rows', () => {
    expect(firstMessagePerConversation([]).size).toBe(0)
  })
})
