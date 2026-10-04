/**
 * Trip-stage pass, section 1: the settle rules, pinned for every kind, plus the two render cases
 * the store is FOR — the pending-action note in the chat and the retry bubble.
 *
 * `.ts`, not `.tsx`, like every other render test here: esbuild's `.ts` loader does not parse
 * JSX, so every element is built with `createElement`.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PENDING_BACKSTOP_MS, actionNote, resultTimesFor, serverStateFor, settlePending,
  type PendingEntry, type ServerState,
} from '../web/components/pending.js'
import { ThreadView } from '../web/components/Thread.js'
import { MessageBubble } from '../web/components/MessageBubble.js'

const AT = 1_000_000

function server(overrides: Partial<ServerState> = {}): ServerState {
  return { userMessages: [], resultRows: [], proposals: [], ...overrides }
}

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    id: 'e1', at: AT, kind: 'message', text: 'a week in Lisbon', seenCount: 0, failed: false,
    ...overrides,
  }
}

function proposalRow(overrides: Partial<ServerState['proposals'][number]> = {}) {
  return {
    id: 'p1', decision: null as 'accept' | 'reject' | null, sourceIds: [],
    hasFlight: false, hasStay: false, ...overrides,
  }
}

describe('settlePending: her own words', () => {
  it('settles once a user row with that text exists that the server did not have before', () => {
    expect(settlePending(server(), entry(), AT)).toBe(false)
    expect(settlePending(server({ userMessages: ['a week in Lisbon'] }), entry(), AT)).toBe(true)
  })

  /*
   * The brief's rule is "a user row with the same text NEWER than `at`", read as a count rather
   * than a timestamp comparison: `at` comes from the browser and `created_at` from Postgres, and
   * a second of clock skew either way would otherwise leave a bubble doubled for the whole
   * backstop. Counting answers the same question and answers it correctly for the case the rule
   * exists for — the same message sent twice.
   */
  it('does not settle against a row that was already there when she sent it', () => {
    const already = server({ userMessages: ['yes'] })
    const second = entry({ text: 'yes', seenCount: 1 })
    expect(settlePending(already, second, AT)).toBe(false)
    expect(settlePending(server({ userMessages: ['yes', 'yes'] }), second, AT)).toBe(true)
  })

  it('treats a chip and a question card\'s option exactly as it treats a typed message', () => {
    const chip = entry({ kind: 'next', text: 'Direct flights only' })
    const option = entry({ kind: 'choice', text: 'Tokyo' })
    expect(settlePending(server(), chip, AT)).toBe(false)
    expect(settlePending(server({ userMessages: ['Direct flights only'] }), chip, AT)).toBe(true)
    expect(settlePending(server({ userMessages: ['Tokyo'] }), option, AT)).toBe(true)
  })

  it('never matches a non-user row — only `userMessages` is ever looked at', () => {
    // An agent reply quoting her words back is not her words arriving.
    expect(settlePending(server({ userMessages: [] }), entry(), AT)).toBe(false)
  })
})

describe('settlePending: a chosen flight', () => {
  const chose = entry({ kind: 'choose_flight', text: '', sourceId: 'F1' })

  it('waits while nothing has answered', () => {
    expect(settlePending(server(), chose, AT)).toBe(false)
    // A hotels row that was already there is not an answer to THIS choice.
    expect(settlePending(
      server({ resultRows: [{ messageId: 'm0', kind: 'hotels', at: AT - 5_000 }] }), chose, AT,
    )).toBe(false)
  })

  it('settles on a hotels row newer than the click', () => {
    expect(settlePending(
      server({ resultRows: [{ messageId: 'm1', kind: 'hotels', at: AT + 1 }] }), chose, AT,
    )).toBe(true)
  })

  it('settles on a proposal that holds that flight, which is what lands first', () => {
    expect(settlePending(
      server({ proposals: [proposalRow({ hasFlight: true, sourceIds: ['F1'], decision: 'accept' })] }),
      chose, AT,
    )).toBe(true)
    // A proposal holding a DIFFERENT flight is somebody else's answer.
    expect(settlePending(
      server({ proposals: [proposalRow({ hasFlight: true, sourceIds: ['F9'] })] }), chose, AT,
    )).toBe(false)
  })
})

describe('settlePending: a chosen stay', () => {
  const chose = entry({ kind: 'choose_hotel', text: '', sourceId: 'H1' })

  it('waits until a proposal holds that stay', () => {
    expect(settlePending(server(), chose, AT)).toBe(false)
    expect(settlePending(
      server({ proposals: [proposalRow({ hasFlight: true, sourceIds: ['F1'] })] }), chose, AT,
    )).toBe(false)
    expect(settlePending(
      server({ proposals: [proposalRow({ hasStay: true, sourceIds: ['F1', 'H1'] })] }), chose, AT,
    )).toBe(true)
  })

  it('is not settled by a hotels results row, however many of them arrive', () => {
    expect(settlePending(
      server({ resultRows: [{ messageId: 'm1', kind: 'hotels', at: AT + 1 }] }), chose, AT,
    )).toBe(false)
  })
})

describe('settlePending: accept', () => {
  const accept = entry({ kind: 'accept', text: '', sourceId: 'p1' })

  it('waits while the proposal she pressed is still undecided', () => {
    expect(settlePending(server({ proposals: [proposalRow({ id: 'p1' })] }), accept, AT)).toBe(false)
  })

  it('settles once that proposal carries a decision', () => {
    expect(settlePending(
      server({ proposals: [proposalRow({ id: 'p1', decision: 'accept' })] }), accept, AT,
    )).toBe(true)
  })

  it('settles when the cashier has already replaced it with a newer one', () => {
    expect(settlePending(
      server({ proposals: [proposalRow({ id: 'p2' }), proposalRow({ id: 'p1', decision: 'accept' })] }),
      accept, AT,
    )).toBe(true)
  })

  it('never settles against nothing at all', () => {
    expect(settlePending(server(), accept, AT)).toBe(false)
  })
})

describe('settlePending: refresh', () => {
  const refresh = entry({ kind: 'refresh', text: '', sourceId: 'm1' })

  it('waits until a NEWER row of the same kind arrives', () => {
    const one = server({ resultRows: [{ messageId: 'm1', kind: 'flights', at: AT - 100 }] })
    expect(settlePending(one, refresh, AT)).toBe(false)
    // A hotels row is not an answer to a flights refresh.
    const other = server({
      resultRows: [
        { messageId: 'm1', kind: 'flights', at: AT - 100 },
        { messageId: 'm2', kind: 'hotels', at: AT + 1 },
      ],
    })
    expect(settlePending(other, refresh, AT)).toBe(false)
    const replaced = server({
      resultRows: [
        { messageId: 'm1', kind: 'flights', at: AT - 100 },
        { messageId: 'm3', kind: 'flights', at: AT + 1 },
      ],
    })
    expect(settlePending(replaced, refresh, AT)).toBe(true)
  })

  it('settles on any newer row when the one it was fired against is gone', () => {
    const orphan = entry({ kind: 'refresh', text: '', sourceId: 'gone' })
    expect(settlePending(server(), orphan, AT)).toBe(false)
    expect(settlePending(
      server({ resultRows: [{ messageId: 'm9', kind: 'hotels', at: AT + 1 }] }), orphan, AT,
    )).toBe(true)
  })
})

describe('the twenty-second backstop', () => {
  it('clears anything, whatever its own rule says', () => {
    for (const kind of ['message', 'choose_flight', 'choose_hotel', 'accept', 'refresh', 'choice', 'next'] as const) {
      const e = entry({ kind, text: 'x', sourceId: 'z' })
      expect(settlePending(server(), e, AT)).toBe(false)
      expect(settlePending(server(), e, AT + PENDING_BACKSTOP_MS)).toBe(true)
    }
  })

  it('is twenty seconds', () => {
    expect(PENDING_BACKSTOP_MS).toBe(20_000)
  })
})

describe('actionNote', () => {
  /*
   * The three narrated actions say exactly what `describeActionForUi` (src/actions.ts) says for
   * the same action a round trip later, which is what lets the server's own row replace the
   * optimistic note without a word on screen changing. `test/actions.test.ts` pins the other
   * half of that pair.
   */
  it('says what the server will say, and stays silent about bookkeeping', () => {
    expect(actionNote('choose_flight')).toBe('You chose a flight')
    expect(actionNote('choose_hotel')).toBe('You chose a hotel')
    expect(actionNote('accept')).toBe('You accepted the trip')
    expect(actionNote('refresh')).toBe('')
    expect(actionNote('choice')).toBe('')
    expect(actionNote('next')).toBe('')
  })
})

describe('serverStateFor', () => {
  it('projects the page\'s own reads, and derives nothing it did not have', () => {
    const state = serverStateFor({
      messages: [
        { id: 'm1', role: 'user', content: 'a week in Lisbon', created_at: '2026-10-04T10:00:00.000Z' },
        { id: 'm2', role: 'agent', content: 'on it', created_at: '2026-10-04T10:00:01.000Z' },
        { id: 'm3', role: 'results', content: '10 flights shown', created_at: '2026-10-04T10:00:02.000Z' },
      ],
      results: [{ messageId: 'm3', kind: 'flights' } as never],
      proposals: [{
        id: 'p1', totalMinor: '1', currency: 'EUR', gateOutcome: 'approved', reviewIssues: [],
        decision: 'accept',
        items: [{ slot: 'outbound', sourceId: 'F1', kind: 'flight' } as never],
      } as never],
    })
    expect(state.userMessages).toEqual(['a week in Lisbon'])
    expect(state.resultRows).toEqual([
      { messageId: 'm3', kind: 'flights', at: Date.parse('2026-10-04T10:00:02.000Z') },
    ])
    expect(state.proposals).toEqual([
      { id: 'p1', decision: 'accept', sourceIds: ['F1'], hasFlight: true, hasStay: false },
    ])
  })

  it('reads a results row\'s own timestamp off the transcript, and 0 for an unparseable one', () => {
    const times = resultTimesFor([
      { id: 'm1', role: 'results', content: '', created_at: '2026-10-04T10:00:00.000Z' },
      { id: 'm2', role: 'results', content: '', created_at: 'not a date' },
      { id: 'm3', role: 'user', content: '', created_at: '2026-10-04T10:00:00.000Z' },
    ])
    expect(times.m1).toBe(Date.parse('2026-10-04T10:00:00.000Z'))
    expect(times.m2).toBe(0)
    expect(times.m3).toBeUndefined()
  })
})

describe('the chat, reading the store', () => {
  const conversation = { id: 'c1', title: 'Trip', status: 'active', updated_at: '' }

  it('renders the pending-action note as a centred, data-pending row', () => {
    const html = renderToStaticMarkup(createElement(ThreadView, {
      conversation, latestTurn: null, messages: [],
      pendingNote: actionNote('choose_flight'),
    }))
    expect(html).toContain('You chose a flight')
    expect(html).toContain('data-pending="true"')
    expect(html).toContain('message-action')
  })

  it('renders no note at all when nothing is pending', () => {
    const html = renderToStaticMarkup(createElement(ThreadView, {
      conversation, latestTurn: null, messages: [],
    }))
    expect(html).not.toContain('data-pending')
  })

  /*
   * Section 1's failure path. A POST that came back unusable leaves her words on screen with the
   * one thing that can still help — and the retry re-posts with the SAME idempotency key, which
   * is what stops a second attempt becoming a second row (`MessageBox.post`).
   */
  it('offers a retry on a bubble whose POST failed', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, {
      role: 'user', content: 'a week in Lisbon', pending: true, failed: true,
    }))
    expect(html).toContain('Not sent, tap to retry')
    expect(html).toContain('data-failed="true"')
    expect(html).toContain('<button')
  })

  it('offers nothing to press on a bubble that is simply still in flight, just a muted tick', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, {
      role: 'user', content: 'a week in Lisbon', pending: true,
    }))
    expect(html).not.toContain('Not sent, tap to retry')
    expect(html).toContain('data-pending="true"')
    // The convention every chat client uses for "sent, not acknowledged".
    expect(html).toContain('message-tick')
  })

  it('takes the tick away once the bubble is offering a retry instead', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, {
      role: 'user', content: 'a week in Lisbon', pending: true, failed: true,
    }))
    expect(html).not.toContain('message-tick')
  })
})
