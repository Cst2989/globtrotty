'use client'

import { useState, type ReactNode } from 'react'
import { CaretLeft, CaretRight, List, X } from '@phosphor-icons/react'

export type AppShellProps = {
  /** The server-rendered `Sidebar`; passed as an element so it stays a Server Component. */
  rail: ReactNode
  /** Shown in the mobile top bar; the desktop layout has no top bar. */
  title: string
  children: ReactNode
  /**
   * Task 10: whether the DESKTOP rail starts collapsed to its 56px icon
   * strip — the page passes `hasResults` (a results-first conversation has
   * more pressing uses for the width than the trip list). This is only the
   * default: the rail-top toggle this component renders pins it open or
   * closed from there on, and that click (not this prop) owns the state
   * afterwards. Has no effect below 900px, where the rail is always the
   * off-canvas drawer instead.
   */
  collapsed?: boolean
}

/**
 * The two-column chat shell: a conversation rail on the left, one main
 * column on the right.
 *
 * Below 900px the rail becomes an off-canvas drawer toggled from the top
 * bar — `open` below. At 901px and up (Task 10), the rail can instead be
 * COLLAPSED to a 56px icon strip (`railCollapsed`); collapsed, hovering or
 * focusing it expands it as the same kind of overlay the mobile drawer
 * already is (pure CSS — `.shell[data-rail-collapsed]` in
 * `app/globals.css`), and the small toggle button rendered here pins it
 * open or closed. `Sidebar`'s own markup never changes between the two
 * widths: the collapsed look is CSS hiding the text labels `Sidebar` wraps
 * in spans for exactly this, so there is nothing for the server/client
 * render to disagree about.
 *
 * The rail itself is rendered on the server and handed in as a prop, so
 * this component never touches Supabase or the data layer.
 */
export function AppShell({ rail, title, children, collapsed = false }: AppShellProps) {
  const [open, setOpen] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(collapsed)

  return (
    <div className="shell" data-rail={open ? 'open' : 'closed'} data-rail-collapsed={railCollapsed ? 'true' : 'false'}>
      <div className="rail" onClick={(event) => {
        // A conversation link tapped inside the drawer closes it.
        if ((event.target as HTMLElement).closest('a')) setOpen(false)
      }}>
        {rail}
        <button
          type="button"
          className="btn btn-ghost btn-icon rail-collapse"
          aria-label={railCollapsed ? 'Expand conversations' : 'Collapse conversations'}
          aria-expanded={!railCollapsed}
          onClick={(event) => {
            event.stopPropagation()
            setRailCollapsed((value) => !value)
          }}
        >
          {railCollapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}
        </button>
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
