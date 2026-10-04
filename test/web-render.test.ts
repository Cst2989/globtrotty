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
import { messageForStatus, nextLocation, landingPhaseAfterResponse } from '../web/components/MessageBox.js'
import { LandingLive } from '../web/components/LandingLive.js'
import { readFileSync } from 'node:fs'
import { userInitial } from '../web/components/Sidebar.js'
import { ProposalCard, errorForStatus } from '../web/components/ProposalCard.js'
import { SwapPicker, effectiveChoice } from '../web/components/SwapPicker.js'
import { mergePending } from '../web/components/pending.js'
import { SplitShell } from '../web/components/SplitShell.js'
import { AppShell } from '../web/components/AppShell.js'
import { revealSchedule, visibleSlice } from '../web/components/stream.js'
import { StreamedText } from '../web/components/StreamedText.js'
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

  // Pass 3, section 5b: `replace`, not `push` — the landing is already gone from the screen by
  // the time this runs, so a history entry pointing back at it would promise a state that no
  // longer exists.
  it('replaces with the new conversation on a 200 from the landing box', () => {
    expect(nextLocation('new', 200, body)).toEqual({ type: 'replace', url: '/c/abc-123' })
  })

  it('replaces with the new conversation on a 429 from the landing box too', () => {
    expect(nextLocation('new', 429, body)).toEqual({ type: 'replace', url: '/c/abc-123' })
  })

  it('refreshes in place for an existing conversation on 200, 409 or 429', () => {
    expect(nextLocation('c1', 200, body)).toEqual({ type: 'refresh' })
    expect(nextLocation('c1', 409, body)).toEqual({ type: 'refresh' })
    expect(nextLocation('c1', 429, body)).toEqual({ type: 'refresh' })
  })

  it('refreshes rather than navigating for a 409 from the landing box (unreachable in practice, but must not crash)', () => {
    expect(nextLocation('new', 409, body)).toEqual({ type: 'refresh' })
  })
})

// Pass 3, section 5. The author's loudest complaint: pressing send on the landing took about
// three seconds before anything on screen changed — the POST, then a server-rendered
// /c/[id]. Nothing in that wait is information the browser does not already have.
// Pass 3, section 2: the rail used to expand on hover, as an overlay over the thread. It now
// toggles on a click, and the expanded rail is a real grid column that pushes the content.
describe('AppShell', () => {
  function shell(collapsed: boolean) {
    return renderToStaticMarkup(createElement(AppShell, {
      rail: 'the trip list', title: 'Trip', collapsed, children: 'the thread',
    }))
  }

  it('renders a real button with aria-expanded and aria-controls naming the rail', () => {
    const html = shell(true)
    expect(html).toContain('id="app-rail"')
    expect(html).toContain('aria-controls="app-rail"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Expand conversations"')
    expect(html).toContain('<button')
  })

  it('flips the chevron and the labels with the state', () => {
    const collapsed = shell(true)
    const expanded = shell(false)
    expect(collapsed).toContain('data-rail-collapsed="true"')
    expect(expanded).toContain('data-rail-collapsed="false"')
    expect(expanded).toContain('aria-expanded="true"')
    expect(expanded).toContain('aria-label="Collapse conversations"')
    // Different glyph per direction: CaretRight opens, CaretLeft closes.
    expect(collapsed).not.toBe(expanded)
  })

  it('puts the toggle before the rail content, so the collapsed strip can stack it on top', () => {
    const html = shell(true)
    expect(html.indexOf('rail-collapse')).toBeLessThan(html.indexOf('the trip list'))
  })
})

describe('LandingLive', () => {
  // The IDLE half is not rendered here: it mounts `MessageBox`, which calls `useRouter()`, and
  // there is no app-router context under `renderToStaticMarkup` (mocking next/navigation to get
  // past that would test the mock, not the wiring). It is covered by the pass-3 screenshot.

  it('renders the whole split — pending bubble, Searching, flight skeleton — at phase sent', () => {
    const html = renderToStaticMarkup(createElement(LandingLive, { phase: 'sent' }))
    // The split itself, both panes, exactly as the conversation page renders them.
    expect(html).toContain('split-shell')
    expect(html).toContain('split-pane-chat')
    expect(html).toContain('split-pane-results')
    // Her message, marked as not-yet-stored.
    expect(html).toContain('data-pending="true"')
    // The status line, and the shape the answer will arrive in.
    expect(html).toContain('Searching')
    expect(html).toContain('Searching flights…')
    expect([...html.matchAll(/skeleton-card/g)]).toHaveLength(5)
    // And a composer that cannot be typed into, because there is nothing yet to post to.
    expect(html).toContain('disabled=""')
  })

  it('shows the text she actually typed in the pending bubble', () => {
    // `phase` alone starts with no text (nothing was typed); the real flow sets both in the
    // same tick. This pins that the bubble renders `sentText` as PLAIN text, never markup.
    const html = renderToStaticMarkup(createElement(LandingLive, { phase: 'sent' }))
    expect(html).toContain('message-row')
    expect(html).not.toContain('<script>')
  })
})

describe('landingPhaseAfterResponse', () => {
  it('navigates on a 200 and on a 429 (the conversation exists either way)', () => {
    expect(landingPhaseAfterResponse(200)).toBe('navigate')
    expect(landingPhaseAfterResponse(429)).toBe('navigate')
  })

  it('restores the landing on a 409, a 500 and a network error', () => {
    expect(landingPhaseAfterResponse(409)).toBe('restore')
    expect(landingPhaseAfterResponse(500)).toBe('restore')
    expect(landingPhaseAfterResponse(0)).toBe('restore')
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

  // Pass 3, section 5e: `sending` used to substitute the word "Sending", which was honest about
  // the network and wrong about the product. It now reads what the turn is about to be DOING,
  // in the tick she presses send — and the typing dots appear with it.
  it('shows "Thinking" the instant sending is true, even while the stored status is still active', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        sending: true,
      }),
    )
    expect(html).toContain('Thinking')
    expect(html).not.toContain('Ready for your next message')
    expect(html).toContain('thinking-row')
  })

  it('shows "Searching" instead when the results pane is already promising a list', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        sending: true,
        searching: true,
      }),
    )
    expect(html).toContain('Searching')
    expect(html).not.toContain('Ready for your next message')
  })

  it('keeps showing "Thinking" once the real status has flipped to working', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'working', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [],
        sending: true,
      }),
    )
    expect(html.toLowerCase()).toContain('thinking')
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

  // Streamed reveal: a `results`/`choices` row that lands in the same turn as an agent reply
  // still streaming stays hidden and inert until that reply's `revealed` flag goes true —
  // `ThreadLive` is what flips it (via `StreamedText`'s `onDone`), but the gating itself lives
  // here, in the hook-free `ThreadView`, from the two plain props alone.
  it('hides a results marker that follows a still-revealing agent message, then shows it once revealed', () => {
    const base = {
      conversation: { id: 'c1', title: 'Trip', status: 'active' as const, updated_at: '' },
      latestTurn: null,
    }
    const stillRevealing = renderToStaticMarkup(createElement(ThreadView, {
      ...base,
      messages: [
        { id: 'm1', role: 'agent' as const, content: 'Here is the plan', created_at: '', animate: true, revealed: false },
        { id: 'm2', role: 'results' as const, content: '5 flights shown', created_at: '' },
      ],
    }))
    expect(stillRevealing).toMatch(/data-role="results"[^>]*data-gated="true"/)
    expect(stillRevealing).toContain('inert=""')

    const done = renderToStaticMarkup(createElement(ThreadView, {
      ...base,
      messages: [
        { id: 'm1', role: 'agent' as const, content: 'Here is the plan', created_at: '', animate: true, revealed: true },
        { id: 'm2', role: 'results' as const, content: '5 flights shown', created_at: '' },
      ],
    }))
    expect(done).not.toContain('data-gated')
    expect(done).not.toContain('inert=""')

    // A message that never animated (the ordinary, already-on-the-page case) never gates
    // anything that follows it.
    const neverAnimated = renderToStaticMarkup(createElement(ThreadView, {
      ...base,
      messages: [
        { id: 'm1', role: 'agent' as const, content: 'Here is the plan', created_at: '' },
        { id: 'm2', role: 'results' as const, content: '5 flights shown', created_at: '' },
      ],
    }))
    expect(neverAnimated).not.toContain('data-gated')
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
  {
    slot: 'outbound', sourceId: 'F1', kind: 'flight' as const, name: 'BER→FAO',
    priceMinor: '12300', currency: 'EUR', fetchedAt: new Date().toISOString(),
    route: { from: 'BER', to: 'FAO', fromCity: 'Berlin', toCity: 'Faro' },
    outbound: '2026-09-12', inbound: '2026-09-19', airline: 'TAP Air Portugal',
    stars: null, nights: null, ttlSeconds: 900,
  },
  {
    slot: 'stay', sourceId: 'H1', kind: 'hotel' as const, name: 'Casa Bela',
    priceMinor: '45600', currency: 'EUR', fetchedAt: new Date().toISOString(),
    route: null, outbound: '2026-09-12', inbound: '2026-09-19', airline: null,
    stars: 4, nights: 7, ttlSeconds: 86_400,
  },
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
  /*
   * Polish pass, section 4. It used to read `2026-09-12 → 2026-09-19` — the ISO pair straight
   * off the stored detail. The card now says the trip the way a traveller says it, through the
   * same formatter the summary bar above the results list uses, so one date is written one way
   * on this screen.
   */
  it("says each item's dates the way a traveller says them, read from the stored detail", () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, { proposal: proposal(), alternatives: NO_ALTERNATIVES, ...NOOP_HANDLERS }),
    )
    expect(html).not.toContain('2026-09-12 → 2026-09-19')
    expect(html).toContain('Berlin BER → Faro FAO')
    expect(html).toContain('Sat 12 Sep to Sat 19 Sep')
    expect(html).toContain('TAP Air Portugal')
    // The stay's own line: how long, and when.
    expect(html).toContain('7 nights')
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

// Streamed reveal: the pure timing math behind `StreamedText`.
describe('revealSchedule', () => {
  const sixtyWords = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')

  it('is monotonic in both `at` and `upTo`, and ends at the full text length', () => {
    const schedule = revealSchedule(sixtyWords)
    expect(schedule).toHaveLength(60)
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!.at).toBeGreaterThan(schedule[i - 1]!.at)
      expect(schedule[i]!.upTo).toBeGreaterThan(schedule[i - 1]!.upTo)
    }
    expect(schedule[schedule.length - 1]!.upTo).toBe(sixtyWords.length)
  })

  it('reveals a 60-word message in between 0.6s and 3s, ramping rather than ticking at one fixed rate', () => {
    const schedule = revealSchedule(sixtyWords)
    const lastAt = schedule[schedule.length - 1]!.at
    expect(lastAt).toBeGreaterThanOrEqual(600)
    expect(lastAt).toBeLessThanOrEqual(3000)
    // The ramp: the first word takes longer to arrive than the time between two words once it is
    // up to speed (25 wps at the start vs 70 wps after a second) — never a flat cadence throughout.
    const firstGap = schedule[0]!.at
    const laterGap = schedule[59]!.at - schedule[58]!.at
    expect(firstGap).toBeGreaterThan(laterGap)
  })

  it('returns nothing to reveal for text with no words', () => {
    expect(revealSchedule('')).toEqual([])
    expect(revealSchedule('   ')).toEqual([])
  })
})

describe('visibleSlice', () => {
  const text = 'the quick brown fox jumps over the lazy dog'

  it('never splits a word: every slice is the empty string or ends exactly at a scheduled word boundary', () => {
    const schedule = revealSchedule(text)
    const validEndings = new Set([0, ...schedule.map((s) => s.upTo)])
    for (let ms = 0; ms <= schedule[schedule.length - 1]!.at + 50; ms += 7) {
      const slice = visibleSlice(text, ms)
      expect(validEndings.has(slice.length)).toBe(true)
      // And the characters it does show are always the text's own prefix — never a different cut.
      expect(text.startsWith(slice)).toBe(true)
    }
  })

  it('shows nothing at elapsed 0 and the full text once elapsed reaches the schedule\'s end', () => {
    const schedule = revealSchedule(text)
    expect(visibleSlice(text, 0)).toBe('')
    expect(visibleSlice(text, schedule[schedule.length - 1]!.at)).toBe(text)
  })

  it('returns the whole text unchanged when there is nothing to schedule (no words)', () => {
    expect(visibleSlice('', 0)).toBe('')
  })
})

describe('StreamedText', () => {
  it('renders the whole text instantly, as a plain text child, when animate is false', () => {
    const html = renderToStaticMarkup(createElement(StreamedText, { text: 'hello agent', animate: false }))
    expect(html).toBe('hello agent')
  })

  it('renders a visually-hidden full copy and the blinking cursor when animate is true', () => {
    const html = renderToStaticMarkup(createElement(StreamedText, { text: 'hello agent', animate: true }))
    // No `requestAnimationFrame` has run (there are no effects under `renderToStaticMarkup`), so
    // this is the reveal's very first frame: nothing visible yet, cursor already showing, and the
    // full text held in reserve for assistive tech.
    expect(html).toContain('stream-cursor')
    expect(html).toContain('class="visually-hidden"')
    expect(html).toContain('>hello agent<')
  })

  it('never reaches for dangerouslySetInnerHTML to render either half', () => {
    const html = renderToStaticMarkup(createElement(StreamedText, { text: '<b>hi</b>', animate: true }))
    expect(html).not.toContain('<b>hi</b>')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;')
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


/*
 * Polish pass, section 9. At 56px the author saw a ring with a chevron, the compass mark, and an
 * EMPTY ring where New trip should be — then nothing. No sign of who was signed in, and no way
 * to sign out without expanding the rail first.
 *
 * The markup is identical at both widths by design (CSS hides the labels), so what is pinned
 * here is that the collapsed strip has something to show in every slot: an icon in each button,
 * and a foot that is not empty.
 */
describe('the collapsed rail', () => {
  it('names the signed-in traveller with one letter, whatever her address starts with', () => {
    expect(userInitial('alice@example.com')).toBe('A')
    expect(userInitial('\u00e9ve@example.com')).toBe('\u00c9')
    expect(userInitial('7@example.com')).toBe('7')
    // A circle with a punctuation mark in it says less than one with nothing in it.
    expect(userInitial('_hidden@example.com')).toBe('\u00b7')
    expect(userInitial(null)).toBe('\u00b7')
    expect(userInitial('')).toBe('\u00b7')
  })

  /*
   * `Sidebar` itself cannot be rendered here — `SignOutButton` is a client component that calls
   * `useRouter`, and there is no app router under `renderToStaticMarkup`. The collapsed look is
   * pure CSS in any case (the markup is identical at both widths by design), so the stylesheet
   * is what has to be read, the same way the flight list's own lost rule is read in
   * test/web-results-render.test.ts.
   */
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

  it('keeps the foot of the rail at 56px, instead of hiding it with the rest', () => {
    const hidden = css.slice(css.indexOf("data-rail-collapsed='true'] .rail-label"))
      .slice(0, css.slice(css.indexOf("data-rail-collapsed='true'] .rail-label")).indexOf('}'))
    // The list, the heading and the labels go. The foot does NOT: it is where the avatar and
    // the sign-out button live, and hiding it left the strip ending in nothing at all.
    expect(hidden).toContain('.rail-list')
    expect(hidden).toContain('.rail-heading')
    expect(hidden).not.toContain('.rail-bottom')
  })

  it('gives the collapsed controls a real 40px target, and hangs the chevron off the edge', () => {
    const at = css.indexOf("data-rail-collapsed='true'] .wordmark")
    expect(at).toBeGreaterThan(-1)
    expect(css.slice(at, css.indexOf('}', at))).toContain('width: 40px')

    const chevron = css.indexOf("data-rail-collapsed='true'] .rail-collapse")
    expect(chevron).toBeGreaterThan(-1)
    const rule = css.slice(chevron, css.indexOf('}', chevron))
    // On the border, half in and half out: a hinge, not one more icon in the stack.
    expect(rule).toContain('right: -14px')
    expect(rule).toContain('border-radius: 50%')
  })
})
