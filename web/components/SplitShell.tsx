'use client'

import { useEffect, useState, type ReactNode } from 'react'

export type SplitShellProps = {
  /** Scopes the "has she seen the Results tab's newest row" sessionStorage key to one conversation. */
  conversationId: string
  /** The `Thread` (with its composer already in its `composer` slot). Rendered exactly once — see the file doc comment. */
  chat: ReactNode
  /** The live `ResultsPane`. Rendered exactly once alongside `chat`. */
  results: ReactNode
  /** The newest `results` row's `messageId`, or `null` before any exist — drives the mobile Results tab's "new" badge. */
  latestResultsId: string | null
}

function seenKey(conversationId: string): string {
  return `gt-results-seen:${conversationId}`
}

/** Per-viewer convenience only (spec's own rule for browser storage) — a cleared/blocked store just means the badge never clears until the tab is opened, never a crash. */
function readSeenId(conversationId: string): string | null {
  try {
    return sessionStorage.getItem(seenKey(conversationId))
  } catch {
    return null
  }
}

function writeSeenId(conversationId: string, id: string): void {
  try {
    sessionStorage.setItem(seenKey(conversationId), id)
  } catch {
    // Nothing to recover: the badge simply keeps showing until she opens the tab again this session.
  }
}

/**
 * The Kayak-style split (Task 10). `chat` and `results` are each rendered
 * EXACTLY ONCE in the DOM — never once per layout — because `chat` carries
 * `ThreadLive`'s own Realtime subscription and optimistic-send state;
 * mounting it twice would open two subscriptions and show two independent
 * composers. Instead, CSS alone decides what is visible:
 *
 * - At >=1024px, `.split-pane-chat` (25%, `min-width: 320px`) and
 *   `.split-pane-results` sit side by side and `.split-tabs` is hidden.
 * - Below that, exactly one pane is shown at a time, picked by this
 *   component's own `tab` state and reflected in the `data-tab` attribute
 *   `app/globals.css` keys its `display` rules on.
 *
 * The Results tab carries a small badge once a newer `results` row
 * (`latestResultsId`) has arrived than the one this browser last saw there
 * (`sessionStorage`, try/catch, a per-viewer convenience — never relied on
 * for correctness). Opening the tab marks that id seen.
 */
export function SplitShell({ conversationId, chat, results, latestResultsId }: SplitShellProps) {
  const [tab, setTab] = useState<'chat' | 'results'>('chat')
  const [seenId, setSeenId] = useState<string | null>(null)

  useEffect(() => {
    setSeenId(readSeenId(conversationId))
  }, [conversationId])

  useEffect(() => {
    if (tab !== 'results' || latestResultsId === null || latestResultsId === seenId) return
    writeSeenId(conversationId, latestResultsId)
    setSeenId(latestResultsId)
  }, [tab, latestResultsId, seenId, conversationId])

  const badge = latestResultsId !== null && latestResultsId !== seenId

  return (
    <div className="split-shell" data-tab={tab}>
      <div className="split-tabs" role="tablist" aria-label="Chat and results">
        <button
          type="button"
          role="tab"
          id="split-tab-chat"
          aria-selected={tab === 'chat'}
          aria-controls="split-pane-chat"
          className="split-tab"
          onClick={() => setTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          id="split-tab-results"
          aria-selected={tab === 'results'}
          aria-controls="split-pane-results"
          className="split-tab"
          onClick={() => setTab('results')}
        >
          Results
          {badge ? <span className="split-tab-badge" aria-label="New results" /> : null}
        </button>
      </div>
      <div
        id="split-pane-chat"
        role="tabpanel"
        aria-labelledby="split-tab-chat"
        className="split-pane split-pane-chat"
      >
        {chat}
      </div>
      <div
        id="split-pane-results"
        role="tabpanel"
        aria-labelledby="split-tab-results"
        className="split-pane split-pane-results"
      >
        {results}
      </div>
    </div>
  )
}
