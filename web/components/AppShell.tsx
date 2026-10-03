'use client'

import { useState, type ReactNode } from 'react'
import { List, X } from '@phosphor-icons/react'

export type AppShellProps = {
  /** The server-rendered `Sidebar`; passed as an element so it stays a Server Component. */
  rail: ReactNode
  /** Shown in the mobile top bar; the desktop layout has no top bar. */
  title: string
  children: ReactNode
}

/**
 * The two-column chat shell: a conversation rail on the left, one main
 * column on the right. Below 900px the rail becomes an off-canvas drawer
 * toggled from the top bar; the only client state here is whether that
 * drawer is open. The rail itself is rendered on the server and handed in as
 * a prop, so this component never touches Supabase or the data layer.
 */
export function AppShell({ rail, title, children }: AppShellProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="shell" data-rail={open ? 'open' : 'closed'}>
      <div className="rail" onClick={(event) => {
        // A conversation link tapped inside the drawer closes it.
        if ((event.target as HTMLElement).closest('a')) setOpen(false)
      }}>
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
