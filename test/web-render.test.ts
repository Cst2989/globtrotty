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
import { ThreadView } from '../web/components/Thread.js'
import { messageForStatus, nextLocation } from '../web/components/MessageBox.js'
import { ProposalCard, errorForStatus } from '../web/components/ProposalCard.js'
import { SwapPicker, effectiveChoice } from '../web/components/SwapPicker.js'
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
})

describe('StatusLine', () => {
  it('maps a working status to plain words', () => {
    const html = renderToStaticMarkup(createElement(StatusLine, { status: 'working', failReason: null }))
    expect(html.toLowerCase()).toContain('thinking')
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
