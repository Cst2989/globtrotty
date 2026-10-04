'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { CaretLeft, CaretRight, List, X } from '@phosphor-icons/react'

export type AppShellProps = {
  /** The server-rendered `Sidebar`; passed as an element so it stays a Server Component. */
  rail: ReactNode
  /** Shown in the mobile top bar; the desktop layout has no top bar. */
  title: string
  children: ReactNode
  /**
   * Whether the DESKTOP rail starts collapsed to its 56px icon strip — the
   * page passes `hasResults` (a results-first conversation has more pressing
   * uses for the width than the trip list).
   *
   * This is only the DEFAULT, and only until this browser has an opinion:
   * pass 3 (section 2) persists her own click under `globetrotty.rail` in
   * `localStorage` and reads it on mount, so a rail she pinned open stays
   * open across conversations and reloads. Has no effect below 900px, where
   * the rail is always the off-canvas drawer instead.
   */
  collapsed?: boolean
}

const RAIL_KEY = 'globetrotty.rail'

/**
 * Per-viewer convenience only, so every access is wrapped: a private window, cleared site data
 * or a blocked store means the rail falls back to the `collapsed` default, never a crash.
 */
function readRailCollapsed(): boolean | null {
  try {
    const stored = localStorage.getItem(RAIL_KEY)
    if (stored === 'collapsed') return true
    if (stored === 'expanded') return false
    return null
  } catch {
    return null
  }
}

function writeRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, collapsed ? 'collapsed' : 'expanded')
  } catch {
    // Nothing to recover: the rail keeps working, it just forgets between reloads.
  }
}

/**
 * The two-column chat shell: a conversation rail on the left, one main
 * column on the right.
 *
 * Below 900px the rail becomes an off-canvas drawer toggled from the top
 * bar — `open` below. At 901px and up the rail can instead be COLLAPSED to a
 * 56px icon strip (`railCollapsed`), and the chevron button rendered here is
 * the ONLY thing that toggles it.
 *
 * Pass 3, section 2: it used to expand on `:hover`/`:focus-within`, as an
 * overlay floating above the main column. Two problems, both of which the
 * author hit. A rail that opens because the pointer passed over it opens
 * when she did not ask and closes while she is reading it; and an overlay
 * covers the thread rather than making room for the list, so the one state
 * where she wants the trip list is the state where it hides the
 * conversation. Now a click toggles it, the chevron says which way it will
 * go, and the expanded rail PUSHES the content (it is a real grid column,
 * 272px) instead of sitting on top of it.
 *
 * `Sidebar`'s own markup never changes between the two widths: the collapsed
 * look is CSS hiding the text labels it wraps in spans for exactly this, so
 * there is nothing for the server and client render to disagree about. The
 * stored preference is read in an effect for the same reason — the server
 * cannot know it, and reading it during render would make the first client
 * render disagree with the HTML it is hydrating.
 */
export function AppShell({ rail, title, children, collapsed = false }: AppShellProps) {
  const [open, setOpen] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(collapsed)

  useEffect(() => {
    const stored = readRailCollapsed()
    if (stored !== null) setRailCollapsed(stored)
  }, [])

  function toggleRail() {
    setRailCollapsed((value) => {
      writeRailCollapsed(!value)
      return !value
    })
  }

  return (
    <div className="shell" data-rail={open ? 'open' : 'closed'} data-rail-collapsed={railCollapsed ? 'true' : 'false'}>
      <div id="app-rail" className="rail" onClick={(event) => {
        // A conversation link tapped inside the drawer closes it.
        if ((event.target as HTMLElement).closest('a')) setOpen(false)
      }}>
        {/*
          First in the DOM so the collapsed strip can stack it ABOVE the wordmark; expanded, CSS
          lifts it to the top right of the rail's own header. One button either way, because it
          does one thing and she should not have to find a different control to undo it.
        */}
        <button
          type="button"
          className="btn btn-ghost btn-icon rail-collapse"
          aria-label={railCollapsed ? 'Expand conversations' : 'Collapse conversations'}
          aria-expanded={!railCollapsed}
          aria-controls="app-rail"
          onClick={(event) => {
            event.stopPropagation()
            toggleRail()
          }}
        >
          {railCollapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}
        </button>
        {rail}
      </div>
      <button
        type="button"
        className="scrim"
        aria-label="Close conversations"
        tabIndex={open ? 0 : -1}
        onClick={() => setOpen(false)}
      />
      <div className="shell-main">
        <div className="topbar">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={open ? 'Close conversations' : 'Open conversations'}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={20} /> : <List size={20} />}
          </button>
          <span className="topbar-title">{title}</span>
        </div>
        {children}
      </div>
    </div>
  )
}
