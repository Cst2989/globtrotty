'use client'

import { useEffect, useState } from 'react'

/**
 * `true` once the viewport matches `query`, and ALWAYS `false` on the first render.
 *
 * The first-render answer is load-bearing twice over: there is no viewport during a server
 * render (or under `renderToStaticMarkup` in the render tests), and a hook that guessed would
 * hand React a different tree on the client than the server sent, which is a hydration mismatch.
 * Starting at `false` and correcting in an effect means the narrow layout is what renders first
 * and the wide one arrives a frame later — the right way round, because the narrow layout is the
 * one that works at every width.
 *
 * `addEventListener('change')` rather than the deprecated `addListener`, and the cleanup removes
 * it: a results pane is remounted on every conversation switch.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const list = window.matchMedia(query)
    setMatches(list.matches)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** The width at which the hotels pane shows the list and the map side by side (hotels pass, §5). */
export const SPLIT_QUERY = '(min-width: 1280px)'

/** Whether the person asked for less motion — read once, at the moment a scroll is about to happen. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
