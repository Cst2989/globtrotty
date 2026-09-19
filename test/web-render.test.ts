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

const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444'

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

  it('renders an action row as its plain-language description, never the JSON', () => {
    const content = JSON.stringify({ action: 'hand_off', proposalId: PROPOSAL_ID })
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'action', content }))
    expect(html).toContain('You accepted the proposal')
    expect(html).not.toContain(PROPOSAL_ID)
    expect(html).not.toContain('hand_off')
    expect(html).not.toContain('proposalId')
  })

  it('renders a malformed action row without throwing and without the raw content', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'action', content: 'not json' }))
    expect(html).not.toContain('not json')
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

describe('ThreadView', () => {
  it('renders the message list and an action row through MessageBubble, in order', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadView, {
        conversation: { id: 'c1', title: 'Trip', status: 'active', updated_at: new Date().toISOString() },
        latestTurn: null,
        messages: [
          { id: 'm1', role: 'user', content: 'a week in Lisbon', created_at: new Date().toISOString() },
          {
            id: 'm2',
            role: 'action',
            content: JSON.stringify({ action: 'hand_off', proposalId: PROPOSAL_ID }),
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
    expect(html).not.toContain(PROPOSAL_ID)
    expect(html).not.toContain('<script>')
  })
})
