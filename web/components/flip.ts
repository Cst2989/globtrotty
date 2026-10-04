'use client'

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * A layout effect in the browser (it must run BEFORE the frame the new positions would be
 * painted in, or the list visibly jumps and then animates), and a plain effect on the server,
 * where neither runs and `useLayoutEffect` alone would warn on every static render — including
 * `test/web-results-render.test.ts`'s.
 */
const useLayoutEffectSafe = typeof window === 'undefined' ? useEffect : useLayoutEffect

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // No `matchMedia` (a very old engine, a non-browser runtime): treat the preference as unset.
    return false
  }
}

const DURATION_MS = 320
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Below this, a "move" is a sub-pixel layout wobble, not something worth animating. */
const MIN_DELTA_PX = 1

/**
 * Pass 3 (the author's correction to section 1): the FLIP for a list whose order has just
 * changed under it.
 *
 * A background price refresh does not only replace numbers — the new `results` row carries Jev's
 * new ranking, so Best puts different flights on top, and some cards move several hundred pixels.
 * Rendered plainly that is a list that silently rearranges itself while she is reading it, which
 * reads as a page that broke rather than as prices that updated. So: measure where every card
 * was, let React move them, measure again, put each one back where it was with a transform, and
 * release the transforms on the next frame. The browser animates the difference; the DOM is
 * already correct the whole time.
 *
 * `First, Last, Invert, Play` — the same technique every list-reordering animation uses, done
 * here rather than with a library because it is twenty lines and a dependency is forever.
 *
 * Why not View Transitions, which `web/components/transition.ts` already wraps: a refreshed row
 * arrives through `router.refresh()`, whose DOM update lands an unpredictable number of frames
 * after the call. `startViewTransition` would snapshot before the new rows exist and animate
 * nothing. (Each card still carries its own `view-transition-name`, so a transition started for
 * some OTHER reason — the landing's own cross-fade — pairs cards correctly.)
 *
 * `prefers-reduced-motion: reduce` is a request not to show motion, and a reordering list is
 * motion, so under it this does nothing at all but keep its measurements up to date.
 *
 * `ref` is the list element; every descendant carrying `data-flip-id` is tracked by that id.
 * `key` changes whenever the list's own contents or order could have (the ids, joined), which is
 * what makes this run exactly when there is something to animate.
 */
export function useListFlip(ref: RefObject<HTMLElement | null>, key: string): void {
  const positions = useRef<Map<string, number>>(new Map())

  useLayoutEffectSafe(() => {
    const root = ref.current
    if (!root) return
    const items = [...root.querySelectorAll<HTMLElement>('[data-flip-id]')]

    const next = new Map<string, number>()
    for (const el of items) {
      const id = el.dataset.flipId
      if (id) next.set(id, el.getBoundingClientRect().top)
    }
    const previous = positions.current
    positions.current = next

    // Nothing to compare against on the first pass (the list has only just appeared), and
    // nothing to do at all under reduced motion.
    if (previous.size === 0 || prefersReducedMotion()) return

    for (const el of items) {
      const id = el.dataset.flipId
      if (!id) continue
      const before = previous.get(id)
      const after = next.get(id)
      if (before === undefined || after === undefined) continue
      const delta = before - after
      if (Math.abs(delta) < MIN_DELTA_PX) continue

      el.style.transition = 'none'
      el.style.transform = `translateY(${delta}px)`
      requestAnimationFrame(() => {
        el.style.transition = `transform ${DURATION_MS}ms ${EASING}`
        el.style.transform = ''
      })
    }
  }, [key, ref])
}
