import Link from 'next/link'
import { Compass, Plus } from '@phosphor-icons/react/dist/ssr'
import type { ConversationSummary } from '@/web/data'
import { SignOutButton } from './SignOutButton'

export type SidebarProps = {
  conversations: ConversationSummary[]
  activeId?: string
  /** The signed-in address, shown at the foot of the rail. */
  userEmail?: string | null
}

/** A conversation's list label: its title once set, else her own opening line, else a placeholder. */
function labelFor(c: ConversationSummary): string {
  return c.title ?? c.firstMessage ?? 'New trip'
}

/**
 * Server component: the conversation rail. The list is what
 * `web/data.ts`'s `listConversations` returns, newest-first. This `<nav>` is
 * the only landmark named "Conversations".
 */
export function Sidebar({ conversations, activeId, userEmail }: SidebarProps) {
  return (
    <nav aria-label="Conversations" style={{ display: 'contents' }}>
      <div className="rail-top">
        <Link href="/" className="wordmark">
          <Compass size={20} weight="duotone" aria-hidden="true" />
          Globetrotty
        </Link>
      </div>
      <Link href="/c/new" className="btn btn-ghost rail-new">
        <Plus size={16} weight="bold" aria-hidden="true" />
        New trip
      </Link>
      <p className="rail-heading">Your trips</p>
      {conversations.length === 0 ? (
        <p className="rail-empty">Nothing planned yet.</p>
      ) : (
        <ul className="rail-list">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/c/${c.id}`}
                aria-current={c.id === activeId ? 'page' : undefined}
                title={labelFor(c)}
              >
                {labelFor(c)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="rail-bottom">
        <span className="rail-user" title={userEmail ?? undefined}>
          {userEmail ?? 'Signed in'}
        </span>
        <SignOutButton />
      </div>
    </nav>
  )
}
