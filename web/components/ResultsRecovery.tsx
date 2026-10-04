'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

export type ResultsRecoveryProps = {
  /** Milliseconds to wait before the one re-read; a prop so a test can make it zero. */
  delayMs?: number
}

/**
 * Polish pass, section 11. Rendered by `app/c/[id]/page.tsx` only when the page has caught itself
 * in a state it should not be in: the transcript holds a `results` row and `loadResults` came
 * back with nothing, so the screen is about to be the plain thread over a conversation that has
 * a list of flights in it.
 *
 * It re-reads the page once, a second later, and never again. One retry is what turns a
 * transient read — a server render that landed between the turn's commit and its visibility, a
 * cached RSC payload from before the row existed — into the right screen. Looping would turn a
 * genuinely unresolvable row (a corpus this reader cannot see) into a page that refreshes
 * forever, which is worse than the wrong layout it is trying to fix.
 *
 * It renders nothing. The one-shot guard is a ref so React's Strict Mode double-invoke of the
 * effect cannot fire two refreshes, and `page.tsx` logs the same disagreement server-side so the
 * next person has something to look at rather than only a screen that corrected itself.
 */
export function ResultsRecovery({ delayMs = 1000 }: ResultsRecoveryProps) {
  const router = useRouter()
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true
    const timer = setTimeout(() => router.refresh(), delayMs)
    return () => clearTimeout(timer)
  }, [router, delayMs])

  return null
}

export default ResultsRecovery
