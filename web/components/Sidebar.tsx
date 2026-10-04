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
 * The letter in the avatar circle at the foot of the rail.
 *
 * `A` for `alice@…`, and a dot for an address that starts with something that is not a letter or
 * a digit — a circle with a punctuation mark in it says less than a circle with nothing in it.
 * Section 9: collapsed, this IS the signed-in row, because the row itself has no room.
 */
export function userInitial(email: string | null | undefined): string {
  const first = (email ?? '').trim().charAt(0)
  return /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : '\u00b7'
}

/**
 * Server component: the conversation rail. The list is what
 * `web/data.ts`'s `listConversations` returns, newest-first. This `<nav>` is
 * the only landmark named "Conversations".
 *
 * Task 10: the wordmark and "New trip" text sit in a `.rail-label` span
 * (with a matching `title` on each link, so the meaning survives even with
 * the text hidden) so `AppShell`'s collapsed, 56px rail can hide just the
 * words and keep the icons — purely a CSS concern (`app/globals.css`'s
 * `.shell[data-rail-collapsed]` rules): this component's own markup and
 * props are unchanged between the collapsed and expanded rail.
 */
export function Sidebar({ conversations, activeId, userEmail }: SidebarProps) {
  return (
    <nav aria-label="Conversations" style={{ display: 'contents' }}>
      <div className="rail-top">
        <Link href="/" className="wordmark" title="Globetrotty">
          <Compass size={22} weight="duotone" aria-hidden="true" />
          <span className="rail-label">Globetrotty</span>
        </Link>
      </div>
      {/* Section 9: 20px, bold, so there is an ICON in the icon rail. At 16px and the old
          `--ink-3` the glyph inside this button was faint enough that the author saw an empty
          ring where the New trip control should be. */}
      <Link href="/c/new" className="btn btn-ghost rail-new" title="New trip">
        <Plus size={20} weight="bold" aria-hidden="true" />
        <span className="rail-label">New trip</span>
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
      {/* Collapsed, this row is an avatar and a sign-out icon, which is the whole of what fits
          and the whole of what it has to say: who is signed in, and how to stop being. It used
          to be hidden outright, so the 56px strip ended in nothing at all. */}
      <div className="rail-bottom">
        <span className="rail-avatar" aria-hidden="true">{userInitial(userEmail)}</span>
        <span className="rail-user rail-label" title={userEmail ?? undefined}>
          {userEmail ?? 'Signed in'}
        </span>
        <SignOutButton />
      </div>
    </nav>
  )
}
