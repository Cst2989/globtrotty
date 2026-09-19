'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney, money } from '@/src/money'
import { SLOT_KINDS } from '@/src/gates/checks'
import type { ProposalRowLite, LinkLite, AlternativeLite } from '@/web/data'
import { SwapPicker } from './SwapPicker'

export type ProposalCardProps = {
  proposal: ProposalRowLite & { links: LinkLite[] }
  alternatives: { flight: AlternativeLite[]; hotel: AlternativeLite[] }
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  pending: boolean
  error: string | null
  onAccept: () => void
  onReject: (reason: string) => void
  onSwap: (slot: string, sourceId: string) => void
  onShift: (days: -2 | 2) => void
}

/** "found 12 min ago" — same rounding rule as `src/tools/cashier.ts` and `src/agents/reviewer.ts`. */
function ageText(fetchedAt: string, now: Date): string {
  const ageMin = Math.max(0, Math.round((now.getTime() - new Date(fetchedAt).getTime()) / 60_000))
  return `found ${ageMin} min ago`
}

/**
 * Spec §2's proposal card, the PURE half — takes every decision (accept,
 * reject, swap, shift) as a callback prop rather than making the request
 * itself, which is what lets `test/web-render.test.ts` render it directly
 * with `renderToStaticMarkup`: `useRouter()` throws outside a mounted app
 * router (confirmed empirically — the fetch-and-refresh version of this
 * component failed every render test with "invariant expected app router to
 * be mounted"), so that concern lives one layer up, in `ProposalCardLive`
 * below. Mirrors `web/components/Thread.tsx`'s `ThreadView`/`ThreadLive`
 * split for the same reason.
 *
 * Buttons render only while `decision` is `null` — a decided card loses them
 * (spec §2: "Decided cards lose their buttons"). A `shipped_unapproved` card
 * shows the reviewer's issues above the buttons regardless of decision. Once
 * accepted, the tracked links (already scoped to accepted proposals by
 * `web/data.ts`'s `loadProposals`) are the ONLY anchors this component
 * renders, each with `rel="noopener noreferrer"` and `target="_blank"` —
 * spec §6's "only anchors are `link_clicks.url`" rule.
 */
export function ProposalCard({
  proposal, alternatives, now, pending, error, onAccept, onReject, onSwap, onShift,
}: ProposalCardProps) {
  const [rejectReason, setRejectReason] = useState('')
  const [openSwapSlot, setOpenSwapSlot] = useState<string | null>(null)
  const clock = now ?? new Date()
  const decided = proposal.decision !== null

  return (
    <div className="proposal-card" data-decision={proposal.decision ?? 'pending'}>
      <ul className="proposal-items">
        {proposal.items.map((item) => {
          const kind = SLOT_KINDS[item.slot as keyof typeof SLOT_KINDS] ?? item.kind
          const slotAlternatives = kind === 'flight' ? alternatives.flight : alternatives.hotel
          return (
            <li key={item.slot} className="proposal-item">
              <span className="proposal-item-slot">{item.slot}</span>{' '}
              <span className="proposal-item-name">{item.name}</span>{' '}
              <span className="proposal-item-price">
                {formatMoney(money(BigInt(item.priceMinor), item.currency))}
              </span>{' '}
              <span className="proposal-item-age">{ageText(item.fetchedAt, clock)}</span>
              {!decided ? (
                <SwapPicker
                  alternatives={slotAlternatives}
                  selectedSourceId={item.sourceId}
                  open={openSwapSlot === item.slot}
                  onToggle={() => setOpenSwapSlot(openSwapSlot === item.slot ? null : item.slot)}
                  onPick={(sourceId) => {
                    setOpenSwapSlot(null)
                    onSwap(item.slot, sourceId)
                  }}
                />
              ) : null}
            </li>
          )
        })}
      </ul>

      <p className="proposal-total">Total: {formatMoney(money(BigInt(proposal.totalMinor), proposal.currency))}</p>

      {proposal.gateOutcome === 'shipped_unapproved' ? (
        <div className="proposal-issues" role="alert">
          <p>The reviewer flagged this proposal:</p>
          <ul>
            {proposal.reviewIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!decided ? (
        <div className="proposal-actions">
          <button type="button" disabled={pending} onClick={onAccept}>
            Accept
          </button>
          <label>
            Reason (optional)
            <input
              type="text"
              value={rejectReason}
              maxLength={2000}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </label>
          <button type="button" disabled={pending} onClick={() => onReject(rejectReason.trim())}>
            Reject
          </button>
          <button type="button" disabled={pending} onClick={() => onShift(-2)}>
            Shift 2 days earlier
          </button>
          <button type="button" disabled={pending} onClick={() => onShift(2)}>
            Shift 2 days later
          </button>
        </div>
      ) : (
        <p className="proposal-decision">{proposal.decision === 'accept' ? 'Accepted' : 'Rejected'}</p>
      )}

      {proposal.decision === 'accept' && proposal.links.length > 0 ? (
        <ul className="proposal-links">
          {proposal.links.map((link) => (
            <li key={link.itemId}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {formatMoney(money(BigInt(link.quotedMinor), link.currency))} — book
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}

export type ProposalCardLiveProps = {
  proposal: ProposalRowLite & { links: LinkLite[] }
  alternatives: { flight: AlternativeLite[]; hotel: AlternativeLite[] }
}

const GENERIC_ERROR = 'That could not be sent. Please try again.'
const BUSY_ERROR = 'The desk is already working on this proposal — please try again shortly.'

/**
 * The client island: owns the fetch calls to `/api/proposals/[id]/decide`
 * and `/revise` (`web/decideRoute.ts` / `web/reviseRoute.ts`) and, on
 * success, calls `router.refresh()` — the conversation's Realtime
 * subscription (`ThreadLive`) already does the same on the `working` status
 * flip the action turn causes, but refreshing here too means the buttons
 * disable immediately rather than waiting on a round trip through Realtime.
 * `app/c/[id]/page.tsx` renders this, not the pure `ProposalCard` above.
 */
export function ProposalCardLive({ proposal, alternatives }: ProposalCardLiveProps) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(path: 'decide' | 'revise', body: unknown) {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/proposals/${proposal.id}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(res.status === 409 ? BUSY_ERROR : GENERIC_ERROR)
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
    } finally {
      setPending(false)
    }
  }

  return (
    <ProposalCard
      proposal={proposal}
      alternatives={alternatives}
      pending={pending}
      error={error}
      onAccept={() => void post('decide', { decision: 'accept' })}
      onReject={(reason) => void post('decide', { decision: 'reject', ...(reason ? { rejectReason: reason } : {}) })}
      onSwap={(slot, sourceId) => void post('revise', { kind: 'swap', slot, sourceId })}
      onShift={(days) => void post('revise', { kind: 'shift', days })}
    />
  )
}
