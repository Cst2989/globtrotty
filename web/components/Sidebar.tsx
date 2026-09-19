import Link from 'next/link'
import type { ConversationSummary } from '@/web/data'

export type SidebarProps = {
  conversations: ConversationSummary[]
  activeId?: string
}

/** A conversation's list label: its title once set, else her own opening line, else a placeholder. */
function labelFor(c: ConversationSummary): string {
  return c.title ?? c.firstMessage ?? 'New conversation'
}

/**
 * Server component: the list `web/data.ts`'s `listConversations` returns,
 * newest-first. `className="sidebar"` reuses the fixed-width, bordered
 * column `app/globals.css` already defines — fix round 1 (Important) moved
 * that class here from `app/layout.tsx`'s now-removed empty placeholder
 * `<aside>`, so this `<nav>` is the only element named "Conversations".
 */
export function Sidebar({ conversations, activeId }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Conversations">
      <Link href="/c/new">New conversation</Link>
      <ul>
        {conversations.map((c) => (
          <li key={c.id}>
            <Link href={`/c/${c.id}`} aria-current={c.id === activeId ? 'page' : undefined}>
              {labelFor(c)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
