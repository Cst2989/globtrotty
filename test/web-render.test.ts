// Plan 4a, Task 7. `renderToStaticMarkup` under Node, no browser/Next runtime
// — the components under test are plain (no hooks needing one). This file is
// `.ts`, not `.tsx` (matching the brief exactly): Vite's default esbuild
// loader for `.ts` does not parse JSX, so every element below is built with
// `createElement` rather than JSX syntax.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from '../web/components/MessageBubble.js'
import { StatusLine } from '../web/components/StatusLine.js'
import { withViewTransition } from '../web/components/transition.js'
import { ThreadView } from '../web/components/Thread.js'
import { messageForStatus, nextLocation } from '../web/components/MessageBox.js'
import { ProposalCard, errorForStatus } from '../web/components/ProposalCard.js'
import { SwapPicker, effectiveChoice } from '../web/components/SwapPicker.js'
import { mergePending } from '../web/components/pending.js'
import { SplitShell } from '../web/components/SplitShell.js'
import type { ProposalRowLite, LinkLite, AlternativeLite } from '../web/data.js'

describe('MessageBubble', () => {
  it('renders an agent message as escaped plain text — no markdown, no script', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        role: 'agent',
        content: '![](https://x/y.png) <script>alert(1)</script>',
      }),
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('![](https://x/y.png)')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders a user message as escaped plain text too', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { role: 'user', content: '<b>hi</b>' }),
    )
    expect(html).not.toContain('<b>hi</b>')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;')
  })

  // Fix round 1 (Minor): `web/data.ts`'s `loadThread` now turns an action
  // row's raw JSON into its plain sentence server-side (see `toThreadView`,
  // tested against that directly in test/web-data.test.ts) — by the time
  // `content` reaches this component it is already that sentence, so there
  // is nothing left for `MessageBubble` to parse. This just pins that an
  // `action` row still gets the `message-action` styling hook and renders
  // exactly like any other row otherwise (escaped plain text, no special
  // JSON handling left in this component at all).
  it('renders an action row\'s already-prepared sentence with the message-action styling hook', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { role: 'action', content: 'You accepted the proposal' }),
    )
    expect(html).toContain('You accepted the proposal')
    expect(html).toContain('message-action')
  })

  it('renders action-role content as escaped plain text too, same as agent/user', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { role: 'action', content: '<script>alert(1)</script>' }),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  // Task 10: the optimistic bubble `ThreadLive` shows ahead of the server's own row.
  it('renders with data-pending="true" when told it is pending', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { role: 'user', content: 'a week in Lisbon', pending: true }),
    )
    expect(html).toContain('data-pending="true"')
  })

  it('omits the data-pending attribute entirely when not pending', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'user', content: 'a week in Lisbon' }))
    expect(html).not.toContain('data-pending')
  })
})

describe('StatusLine', () => {
  it('maps a working status to plain words', () => {
    const html = renderToStaticMarkup(createElement(StatusLine, { status: 'working', failReason: null }))
    expect(html.toLowerCase()).toContain('thinking')
  })

  // Task 10: `ThreadView` substitutes this synthetic status while an
  // optimistic message is in flight and the real status has not yet
  // flipped to `working` — see that component's own `sending` prop.
  it('maps the synthetic "sending" status to "Sending", with the same working tone and dots', () => {
    const html = renderToStaticMarkup(createElement(StatusLine, { status: 'sending', failReason: null }))
    expect(html).toContain('Sending')
    expect(html).toContain('data-tone="working"')
    expect(html).toContain('class="thinking"')
  })

  // Results UI pass 2, E: the other synthetic status — `ThreadView` substitutes it while the
  // results pane is showing a search skeleton, so the line says what is actually happening
  // instead of a generic "Thinking" beside five shimmering flight cards.
  it('maps the synthetic "searching" status to "Searching", with the same working tone and dots', () => {
    const html = renderToStaticMarkup(createElement(StatusLine, { status: 'searching', failReason: null }))
    expect(html).toContain('Searching')
    expect(html).toContain('data-tone="working"')
    expect(html).toContain('class="thinking"')
  })

  it('maps a failed status with a fail_reason to a plain explanation', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, { status: 'failed', failReason: 'provider_down' }),
    )
    expect(html).not.toContain('provider_down')
    expect(html.toLowerCase()).toContain('provider')
  })

  it('never lets an unrecognised fail_reason vanish silently', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, { status: 'failed', failReason: 'some_new_code' }),
    )
    expect(html).toContain('some_new_code')
  })
})

describe('messageForStatus', () => {
  it('tells her a busy (409) send is saved and will be read next', () => {
    expect(messageForStatus(409)).toMatch(/saved/i)
    expect(messageForStatus(409)).toMatch(/read next/i)
  })

  it('tells her a capped (429) send is saved but delayed to tomorrow', () => {
    expect(messageForStatus(429)).toMatch(/saved/i)
    expect(messageForStatus(429)).toMatch(/tomorrow/i)
  })

  it('falls back to the generic could-not-be-sent text for any other status', () => {
    expect(messageForStatus(400)).toMatch(/could not be sent/i)
    expect(messageForStatus(500)).toMatch(/could not be sent/i)
    expect(messageForStatus(0)).toMatch(/could not be sent/i)
  })
})

// Task 8, carried item 1 from Task 7's review: the landing box's 409/429
// branch used to always `router.refresh()`, which for `conversationId ===
// 'new'` refreshed the SAME empty landing page rather than showing the
// conversation `submitMessage` had already created.
describe('nextLocation', () => {
  const body = { conversationId: 'abc-123' }

  it('pushes to the new conversation on a 200 from the landing box', () => {
    expect(nextLocation('new', 200, body)).toEqual({ type: 'push', url: '/c/abc-123' })
  })

  it('pushes to the new conversation on a 429 from the landing box too', () => {
    expect(nextLocation('new', 429, body)).toEqual({ type: 'push', url: '/c/abc-123' })
  })

  it('refreshes in place for an existing conversation on 200, 409 or 429', () => {
    expect(nextLocation('c1', 200, body)).toEqual({ type: 'refresh' })
    expect(nextLocation('c1', 409, body)).toEqual({ type: 'refresh' })
    expect(nextLocation('c1', 429, body)).toEqual({ type: 'refresh' })
  })

  it('refreshes rather than pushes for a 409 from the landing box (unreachable in practice, but must not crash)', () => {
    expect(nextLocation('new', 409, body)).toEqual({ type: 'refresh' })
  })
})

describe('ThreadView', () => {
  it('renders the message list and an already-prepared action row through MessageBubble, in order', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [
          { id: 'm1', role: 'user', content: 'a week in Lisbon', created_at: new Date().toISOString() },
          {
            // Already run through web/data.ts's toThreadView by the time
            // ThreadView sees it — see that test file for the JSON→sentence
            // mapping itself.
            id: 'm2',
            role: 'action',
            content: 'You accepted the proposal',
            created_at: new Date().toISOString(),
          },
          {
            id: 'm3',
            role: 'agent',
            content: '<script>alert(1)</script>',
            created_at: new Date().toISOString(),
          },
        ],
      }),
    )
    expect(html).toContain('a week in Lisbon')
    expect(html).toContain('You accepted the proposal')
    expect(html).not.toContain('<script>')
  })

  // Task 10: a pending (optimistic) message renders through MessageBubble with the attribute.
  it('passes a message\'s own `pending` flag through to MessageBubble as data-pending', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [
          { id: 'p1', role: 'user', content: 'a week in Lisbon', created_at: '', pending: true },
        ],
      }),
    )
    expect(html).toContain('data-pending="true"')
  })

  // Task 10: `sending` substitutes "Sending" for the status words ONLY while the
  // real status has not yet flipped to `working` — once it has, "Thinking" wins.
  it('shows "Sending" when sending is true and status is still active', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        sending: true,
      }),
    )
    expect(html).toContain('Sending')
    expect(html).not.toContain('Ready for your next message')
  })

  it('keeps showing "Thinking" once the real status has flipped to working, even while sending is still true', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'working', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        sending: true,
      }),
    )
    expect(html.toLowerCase()).toContain('thinking')
    expect(html).not.toContain('Sending')
  })

  // E: `searching` wins over the generic "Thinking" for exactly the stretch that IS a search,
  // and says nothing at all when the turn is not working.
  it('shows "Searching" while working and the results pane is showing a skeleton', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'working', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        searching: true,
      }),
    )
    expect(html).toContain('Searching')
    expect(html.toLowerCase()).not.toContain('thinking<')
  })

  it('leaves the words alone when searching is true but the turn is not working', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        searching: true,
      }),
    )
    expect(html).toContain('Ready for your next message')
    expect(html).not.toContain('Searching')
  })
  // The fix wave's Task-10 gap: `ThreadView` never passed `conversationId` to
  // `MessageBubble`, so `MessageBubble` always took its inert `ChoiceCard` branch and no
  // choice card in production could POST.
  //
  // Asserted on the ELEMENT TREE, not on rendered markup: `ChoiceCardLive` calls
  // `useRouter()`, which has no app-router context under `renderToStaticMarkup`, so a static
  // render of the live branch would throw (and mocking next/navigation to get past that would
  // test the mock, not the wiring). `ThreadView` has no hooks of its own, so calling it
  // directly gives the tree it would render, and the prop it forwards is exactly the thing in
  // question. The static markup cases above stay untouched, which is the point of
  // `conversationId` being its own optional prop.
  it('forwards conversationId to every MessageBubble so a choices row can POST', () => {
    const findBubbles = (node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
      if (Array.isArray(node)) {
        for (const child of node) findBubbles(child, out)
        return out
      }
      if (node === null || typeof node !== 'object') return out
      const el = node as { type?: unknown; props?: Record<string, unknown> }
      if (el.type === MessageBubble && el.props) out.push(el.props)
      if (el.props && 'children' in el.props) findBubbles(el.props.children, out)
      return out
    }

    const messages = [
      { id: 'm1', role: 'user' as const, content: 'a week somewhere', created_at: '' },
      {
        id: 'm2', role: 'choices' as const, created_at: '',
        content: JSON.stringify({
          questionId: 'origin', question: 'Which city are you flying from?',
          options: [{ id: 'BCN', label: 'Barcelona' }, { id: 'MAD', label: 'Madrid' }],
        }),
      },
    ]
    const conversation = { id: 'c1', title: 'Trip', status: 'active' as const, updated_at: '' }

    const live = findBubbles(ThreadView({ conversation, conversationId: 'c1', latestTurn: null, messages }))
    expect(live).toHaveLength(2)
    expect(live.every((p) => p.conversationId === 'c1')).toBe(true)

    // Without the prop the bubbles are inert, which is what every static-markup case above
    // relies on — and what used to be true of the live thread too.
    const inert = findBubbles(ThreadView({ conversation, latestTurn: null, messages }))
    expect(inert).toHaveLength(2)
    expect(inert.every((p) => p.conversationId === undefined)).toBe(true)
  })
})

describe('mergePending (Task 10)', () => {
  const SERVER_NOW = [
    { id: 's1', role: 'user' as const, content: 'a week in Lisbon', created_at: '2026-10-03T10:00:00.000Z' },
  ]

  it('appends a pending message that has no matching server row yet', () => {
    const merged = mergePending([], [{ id: 'p1', content: 'a week in Lisbon' }])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'p1', role: 'user', content: 'a week in Lisbon', pending: true })
  })

  it('drops a pending message once the server already has a user row with the same text', () => {
    const merged = mergePending(SERVER_NOW, [{ id: 'p1', content: 'a week in Lisbon' }])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(SERVER_NOW[0])
    expect((merged[0] as { pending?: boolean }).pending).toBeUndefined()
  })

  it('keeps a pending message whose text does not match any server row', () => {
    const merged = mergePending(SERVER_NOW, [{ id: 'p1', content: 'a different trip' }])
    expect(merged.map((m) => m.content)).toEqual(['a week in Lisbon', 'a different trip'])
  })

  it('never matches a pending message against a non-user server row with the same text', () => {
    const agentEcho = [{ id: 's1', role: 'agent' as const, content: 'a week in Lisbon', created_at: '2026-10-03T10:00:00.000Z' }]
    const merged = mergePending(agentEcho, [{ id: 'p1', content: 'a week in Lisbon' }])
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ pending: true })
  })

  it('preserves server order and appends still-pending entries in send order, after', () => {
    const merged = mergePending(SERVER_NOW, [
      { id: 'p1', content: 'first pending' },
      { id: 'p2', content: 'second pending' },
    ])
    expect(merged.map((m) => m.id)).toEqual(['s1', 'p1', 'p2'])
  })

  it('returns an empty list for no server rows and no pending ones', () => {
    expect(mergePending([], [])).toEqual([])
  })
})

describe('SplitShell (Task 10)', () => {
  it('defaults to the chat tab selected, with both panes rendered in the DOM', () => {
    const html = renderToStaticMarkup(
      createElement(SplitShell, {
        conversationId: 'c1',
        chat: createElement('p', null, 'the chat pane'),
        results: createElement('p', null, 'the results pane'),
        latestResultsId: null,
      }),
    )
    expect(html).toContain('data-tab="chat"')
    expect(html).toContain('the chat pane')
    expect(html).toContain('the results pane')
    expect(html).toMatch(/id="split-tab-chat"[^>]*aria-selected="true"/)
  })

  it('shows no badge when there are no results yet', () => {
    const html = renderToStaticMarkup(
      createElement(SplitShell, {
        conversationId: 'c1',
        chat: createElement('p', null, 'chat'),
        results: createElement('p', null, 'results'),
        latestResultsId: null,
      }),
    )
    expect(html).not.toContain('split-tab-badge')
  })

  it('shows the badge on first render when a results row exists and nothing has been seen yet (no sessionStorage reachable during a static render)', () => {
    const html = renderToStaticMarkup(
      createElement(SplitShell, {
        conversationId: 'c1',
        chat: createElement('p', null, 'chat'),
        results: createElement('p', null, 'results'),
        latestResultsId: 'm1',
      }),
    )
    expect(html).toContain('split-tab-badge')
  })
})

const BASE_ITEMS = [
  { slot: 'outbound', sourceId: 'F1', kind: 'flight' as const, name: 'BER→FAO', priceMinor: '12300', currency: 'EUR', fetchedAt: new Date().toISOString(), dates: '2026-09-12 → 2026-09-19' },
  { slot: 'stay', sourceId: 'H1', kind: 'hotel' as const, name: 'Casa Bela', priceMinor: '45600', currency: 'EUR', fetchedAt: new Date().toISOString(), dates: '2026-09-12 → 2026-09-19' },
]
const NO_ALTERNATIVES = { flight: [], hotel: [] }
const ONE_ALTERNATIVE = {
  flight: [{ sourceId: 'F2', name: 'BER→FAO (alt)', priceMinor: '11000', currency: 'EUR', fetchedAt: new Date().toISOString(), ttlSeconds: 900 }],
  hotel: [],
}

function proposal(overrides: Partial<ProposalRowLite & { links: LinkLite[] }> = {}): ProposalRowLite & { links: LinkLite[] } {
  return {
    id: 'p1', totalMinor: '57900', currency: 'EUR', gateOutcome: 'approved', reviewIssues: [],
    decision: null, items: BASE_ITEMS, links: [],
    ...overrides,
  }
}

const NOOP_HANDLERS = {
  pending: false, error: null,
  onAccept: () => {}, onReject: () => {}, onSwap: () => {}, onShift: () => {},
}

describe('ProposalCard', () => {
  it('a pending (decision: null) card shows Accept/Reject buttons and no anchors', () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, { proposal: proposal(), alternatives: NO_ALTERNATIVES, ...NOOP_HANDLERS }),
    )
    expect(html).toContain('Accept')
    expect(html).toContain('Reject')
    expect(html).not.toContain('<a ')
  })

  it('an accepted card with two links renders exactly those two anchors, with the stored hrefs and rel', () => {
    const links: LinkLite[] = [
      { itemId: 'F1', url: 'https://mock.example/book/F1?gt_ref=abc', quotedMinor: '12300', currency: 'EUR' },
      { itemId: 'H1', url: 'https://mock.example/book/H1?gt_ref=def', quotedMinor: '45600', currency: 'EUR' },
    ]
    const html = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: proposal({ decision: 'accept', links }),
        alternatives: NO_ALTERNATIVES,
        ...NOOP_HANDLERS,
      }),
    )
    const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toHaveLength(2)
    expect(hrefs).toEqual(links.map((l) => l.url))
    expect(html).toContain('rel="noopener noreferrer"')
    // Decided: no more buttons (note: "Accepted" below legitimately
    // contains the substring "Accept", so this checks for the button itself).
    expect(html).not.toContain('<button')
    expect(html).toContain('Accepted')
  })

  it('a rejected card has no anchors and no buttons', () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, { proposal: proposal({ decision: 'reject' }), alternatives: NO_ALTERNATIVES, ...NOOP_HANDLERS }),
    )
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('Accept')
  })

  it('a shipped_unapproved card shows the reviewer\'s issues text', () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: proposal({ gateOutcome: 'shipped_unapproved', reviewIssues: ['the stay is far from the beach'] }),
        alternatives: NO_ALTERNATIVES,
        ...NOOP_HANDLERS,
      }),
    )
    expect(html).toContain('the stay is far from the beach')
  })

  // Task 8 review, Minor #9.
  it('shows each item\'s dates, read from the stored detail', () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, { proposal: proposal(), alternatives: NO_ALTERNATIVES, ...NOOP_HANDLERS }),
    )
    expect(html).toContain('2026-09-12 → 2026-09-19')
  })

  /**
   * Final review, M3. A 429 from decide/revise is the spend ceiling —
   * `submitAction` returns `limit_reached` before its transaction, so nothing
   * was written — and the old mapping sent it to the generic "Please try
   * again", advice that cannot work today however many times she takes it.
   * `MessageBox.messageForStatus` already gets this right for the message
   * box; this is the card's version, minus that one's "Your message is
   * saved", which would be false here.
   */
  it('maps 409 to the busy copy, 429 to the spend-ceiling copy, and everything else to the generic one', () => {
    expect(errorForStatus(409)).toContain('already working on this proposal')
    expect(errorForStatus(429)).toContain("Today's spending limit is reached")
    expect(errorForStatus(429)).not.toMatch(/try again/i)
    expect(errorForStatus(429)).not.toMatch(/saved/i)
    expect(errorForStatus(500)).toBe('That could not be sent. Please try again.')
    expect(errorForStatus(404)).toBe('That could not be sent. Please try again.')
  })

  it('renders whatever error copy it is given, as plain text', () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: proposal(), alternatives: NO_ALTERNATIVES, ...NOOP_HANDLERS,
        error: errorForStatus(429),
      }),
    )
    expect(html).toContain('Today&#x27;s spending limit is reached')
  })

  // Task 8 review, Minor #6: Accept/Reject/Shift and the SwapPicker's own
  // "Swap" button are all disabled while a request from this card is in
  // flight.
  it('disables Accept, Reject, Shift and Swap while pending', () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: proposal(), alternatives: ONE_ALTERNATIVE, ...NOOP_HANDLERS, pending: true,
      }),
    )
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)]
    expect(buttons.length).toBeGreaterThan(0)
    for (const [tag] of buttons) {
      expect(tag).toContain('disabled')
    }
  })
})

/**
 * Final review, M2. `SwapPicker`'s `choice` is `useState`, initialised once,
 * and the component stays mounted across `router.refresh()` — so a card that
 * first rendered with NO alternatives for its slot seeded `choice` with the
 * item's own `selectedSourceId`, and kept it after a later search added real
 * alternatives. "Confirm swap" then POSTed the item's own id, which passes
 * `reviseRoute`'s corpus pre-check and burns a turn on a no-op swap.
 *
 * A static render always produces a CONSISTENT first frame — state and props
 * agree by construction — which is exactly why a render test could not see
 * this. So the stale combination is pinned on the pure `effectiveChoice`
 * (state and props as two separate inputs, the shape the second render
 * actually has), and the render tests pin that whatever the `<select>` shows
 * as selected is always one of the options it rendered.
 */
describe('SwapPicker', () => {
  const ALTS: AlternativeLite[] = [
    { sourceId: 'F2', name: 'BER→FAO (alt)', priceMinor: '11000', currency: 'EUR', fetchedAt: new Date().toISOString(), ttlSeconds: 900 },
    { sourceId: 'F3', name: 'BER→FAO (alt 2)', priceMinor: '10500', currency: 'EUR', fetchedAt: new Date().toISOString(), ttlSeconds: 900 },
  ]
  const PICKER = {
    selectedSourceId: 'F1', open: true, pending: false, now: new Date(),
    onToggle: () => {}, onPick: () => {},
  }

  it('keeps a choice that is still among the alternatives', () => {
    expect(effectiveChoice('F3', ALTS)).toBe('F3')
  })

  it('falls back to the first alternative when the choice is no longer one of them', () => {
    // The real stale case: seeded with the item's own id while the corpus had
    // no alternative for this slot, then alternatives arrived.
    expect(effectiveChoice('F1', ALTS)).toBe('F2')
    // And the same for an alternative that has since expired out of the list
    // (`loadAlternatives` drops expired ids — see web/data.ts).
    expect(effectiveChoice('F9', ALTS)).toBe('F2')
  })

  it('is undefined — never the item\'s own id — when there is nothing to swap to', () => {
    expect(effectiveChoice('F1', [])).toBeUndefined()
  })

  it('marks a rendered option as selected, and only one', () => {
    const html = renderToStaticMarkup(
      createElement(SwapPicker, { ...PICKER, alternatives: ALTS }),
    )
    const selected = [...html.matchAll(/<option value="([^"]+)" selected=""/g)].map((m) => m[1])
    expect(selected).toEqual(['F2'])
  })

  it('disables Confirm swap when there is nothing to swap to', () => {
    // `value === undefined` — not `others.length === 0` at one call site and
    // `choice` at another, which is how the stale id got through before.
    const html = renderToStaticMarkup(
      createElement(SwapPicker, { ...PICKER, alternatives: [] }),
    )
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm swap<\/button>/)
  })
})

// Results UI pass 2, E. `withViewTransition` is the landing send's one piece of browser
// polish, and the thing that must never go wrong with it is swallowing the navigation — so
// every fallback path is pinned here. `environment: 'node'` means there is no `document` or
// `window` unless a test puts one there, which is itself the first case.
// Results UI pass 2, F3: a `next` row is not a question, so it renders as a row of ghost
// suggestion chips rather than the question card — and every OTHER questionId keeps the card.
describe('MessageBubble: next-step chips vs the question card', () => {
  const row = (questionId: string) => JSON.stringify({
    questionId, question: questionId === 'next' ? 'What next?' : 'Which city did you mean?',
    options: [{ id: 'direct_only', label: 'Direct flights only' }, { id: 'cheapest', label: 'Cheapest first' }],
  })

  it('renders a `next` row as suggestion chips, with no question heading', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'choices', content: row('next') }))
    expect(html).toContain('next-chips')
    expect(html).toContain('class="suggestion"')
    expect(html).toContain('Direct flights only')
    // The question text is the group's label only — never a heading claiming the office is
    // waiting for an answer.
    expect(html).not.toContain('choice-card')
    expect(html).not.toContain('choice-question')
    expect(html).toContain('aria-label="What next?"')
  })

  it('keeps the question card for every other questionId', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'choices', content: row('destination') }))
    expect(html).toContain('choice-card')
    expect(html).toContain('Which city did you mean?')
    expect(html).not.toContain('next-chips')
  })
})

describe('withViewTransition', () => {
  const globals = globalThis as unknown as {
    document?: unknown
    window?: unknown
  }

  function withGlobals(
    doc: unknown, reduced: boolean | 'throw', body: () => void,
  ) {
    const hadDocument = 'document' in globals
    const hadWindow = 'window' in globals
    const previousDocument = globals.document
    const previousWindow = globals.window
    globals.document = doc
    globals.window = {
      matchMedia: (query: string) => {
        if (reduced === 'throw') throw new Error('no matchMedia')
        return { matches: reduced && query.includes('reduce') }
      },
    }
    try {
      body()
    } finally {
      if (hadDocument) globals.document = previousDocument
      else delete globals.document
      if (hadWindow) globals.window = previousWindow
      else delete globals.window
    }
  }

  it('runs the navigation plainly when there is no document at all', () => {
    const fn = vi.fn()
    withViewTransition(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs the navigation inside the transition when the browser has one', () => {
    const start = vi.fn((callback: () => void) => { callback() })
    const fn = vi.fn()
    withGlobals({ startViewTransition: start }, false, () => withViewTransition(fn))
    expect(start).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('skips the transition under prefers-reduced-motion, but still navigates', () => {
    const start = vi.fn()
    const fn = vi.fn()
    withGlobals({ startViewTransition: start }, true, () => withViewTransition(fn))
    expect(start).not.toHaveBeenCalled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('navigates plainly when the browser has no startViewTransition', () => {
    const fn = vi.fn()
    withGlobals({}, false, () => withViewTransition(fn))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('navigates even when starting the transition throws', () => {
    const fn = vi.fn()
    withGlobals({ startViewTransition: () => { throw new Error('already running') } }, false,
      () => withViewTransition(fn))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('treats a missing matchMedia as "no preference set", never as a reason not to navigate', () => {
    const start = vi.fn((callback: () => void) => { callback() })
    const fn = vi.fn()
    withGlobals({ startViewTransition: start }, 'throw', () => withViewTransition(fn))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
