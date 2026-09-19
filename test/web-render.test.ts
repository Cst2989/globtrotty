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
import { messageForStatus } from '../web/components/MessageBox.js'

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
