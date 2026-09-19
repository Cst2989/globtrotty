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

/** Server component: the list `web/data.ts`'s `listConversations` returns, newest-first. */
export function Sidebar({ conversations, activeId }: SidebarProps) {
  return (
    <nav aria-label="Conversations">
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
