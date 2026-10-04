'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * Pass 3, section 6: the one piece of state two sibling islands both need.
 *
 * The rule the author set is that every click changes the screen in the same tick, before any
 * fetch resolves. Most of that is local — a card knows it was the one clicked, a button knows it
 * was pressed — but two cases cross a component boundary:
 *
 *  1. Pressing Select in the RESULTS pane has to flip the status line in the CHAT column to
 *     "Searching", because that is where she looks to find out whether the desk heard her.
 *  2. Clicking a next-step chip (rendered deep inside the thread, by `ChoiceCardLive`) has to
 *     add the pending user bubble that `ThreadLive` owns the list of.
 *
 * Both are solved the same way: one provider above both islands (`app/c/[id]/page.tsx` wraps
 * whichever branch it renders), `busy` written by whoever just got clicked, and an `optimistic`
 * call that `ThreadLive` fulfils by REGISTERING its own append function here on mount. The
 * registration (rather than lifting the pending list itself) is deliberate: `ThreadLive` already
 * owns that list, with its own per-message timeout and its own content-matched drop rule
 * (`mergePending`), and a second copy of that logic up here would be a second answer to "has the
 * server caught up yet".
 *
 * With no provider above them — nothing in the tree needs one — every function here is a no-op
 * and every consumer still renders, which is what keeps `renderToStaticMarkup` tests of the pure
 * halves unaffected.
 */
export type Activity = {
  /** True from the tick a click happens until the server's own status catches up. */
  busy: boolean
  setBusy: (value: boolean) => void
  /** `ThreadLive` registers its optimistic-append on mount, and clears it on unmount. */
  register: (append: ((text: string) => void) | null) => void
  /** Show `text` as a pending user bubble in the thread, now. */
  optimistic: (text: string) => void
}

const NOOP_ACTIVITY: Activity = {
  busy: false,
  setBusy: () => {},
  register: () => {},
  optimistic: () => {},
}

const ActivityContext = createContext<Activity>(NOOP_ACTIVITY)

export function ActivityProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(false)
  // A ref, not state: registering `ThreadLive`'s append must not re-render anything, and it
  // happens in an effect right after the first paint.
  const appendRef = useRef<((text: string) => void) | null>(null)

  const register = useCallback((append: ((text: string) => void) | null) => {
    appendRef.current = append
  }, [])

  const optimistic = useCallback((text: string) => {
    appendRef.current?.(text)
  }, [])

  // Memoised so the identity is stable: consumers put this object in effect dependency lists.
  const value = useMemo<Activity>(() => ({ busy, setBusy, register, optimistic }), [busy, register, optimistic])

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>
}

export function useActivity(): Activity {
  return useContext(ActivityContext)
}
