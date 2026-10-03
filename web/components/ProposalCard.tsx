'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AirplaneTilt, Bed, ArrowSquareOut } from '@phosphor-icons/react'
import { formatMoney, money } from '@/src/money'
import { SLOT_KINDS } from '@/src/gates/checks'
import type { ProposalRowLite, LinkLite, AlternativeLite } from '@/web/data'
import { SwapPicker } from './SwapPicker'
import { ageText } from './age'

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

/** "outbound_flight" → "Outbound flight". */
function slotLabel(slot: string): string {
  const words = slot.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Spec §2's proposal card, the PURE half: takes every decision (accept,
 * reject, swap, shift) as a callback prop rather than making the request
 * itself, which is what lets `test/web-render.test.ts` render it directly
 * with `renderToStaticMarkup` (`useRouter()` throws outside a mounted app
 * router). The fetch concern lives in `ProposalCardLive` below.
 *
 * Laid out like a flight-search result: one row per itinerary item with a
 * kind icon, name, dates and fetched-age on the left and the price on the
 * right, a total strip, then the actions. Buttons render only while
 * `decision` is `null` (spec §2: "Decided cards lose their buttons"). A
 * `shipped_unapproved` card shows the reviewer's issues above the buttons.
 * Once accepted, the tracked links (already scoped to accepted proposals by
 * `web/data.ts`'s `loadProposals`) are the ONLY anchors this component
 * renders, each with `rel="noopener noreferrer"` and `target="_blank"`
 * (spec §6's "only anchors are `link_clicks.url`" rule).
 */
export function ProposalCard({
  proposal, alternatives, now, pending, error, onAccept, onReject, onSwap, onShift,
}: ProposalCardProps) {
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [openSwapSlot, setOpenSwapSlot] = useState<string | null>(null)
  const clock = now ?? new Date()
  const decided = proposal.decision !== null

  const stateWords =
    proposal.decision === 'accept' ? 'Accepted' : proposal.decision === 'reject' ? 'Rejected' : 'Waiting for your decision'

  return (
    <article className="proposal-card" data-decision={proposal.decision ?? 'pending'} aria-label="Proposed trip">
      <div className="proposal-head">
        <h2>Proposed trip</h2>
        <span className="proposal-state">{stateWords}</span>
      </div>

      <ul className="proposal-items">
        {proposal.items.map((item) => {
          // `Object.hasOwn` before indexing `SLOT_KINDS`: the repo's rule for a
          // closed-vocabulary lookup keyed by a value that originated in stored data.
          const kind = Object.hasOwn(SLOT_KINDS, item.slot)
            ? SLOT_KINDS[item.slot as keyof typeof SLOT_KINDS]
            : item.kind
          const slotAlternatives = kind === 'flight' ? alternatives.flight : alternatives.hotel
          return (
            <li key={item.slot} className="proposal-item">
              <span className="proposal-item-icon" aria-hidden="true">
                {kind === 'flight' ? <AirplaneTilt size={20} /> : <Bed size={20} />}
              </span>
              <div className="proposal-item-main">
                <span className="proposal-item-name">{item.name}</span>
                <span className="proposal-item-meta">
                  <span className="proposal-item-slot">{slotLabel(item.slot)}</span>
                  {item.dates ? <span className="proposal-item-dates">{item.dates}</span> : null}
                  <span className="proposal-item-age">{ageText(item.fetchedAt, clock)}</span>
                </span>
              </div>
              <span className="proposal-item-price">
                {formatMoney(money(BigInt(item.priceMinor), item.currency))}
              </span>
              {!decided ? (
                <div className="proposal-item-tools">
                  <SwapPicker
                    alternatives={slotAlternatives}
                    selectedSourceId={item.sourceId}
                    open={openSwapSlot === item.slot}
                    pending={pending}
                    now={clock}
                    onToggle={() => setOpenSwapSlot(openSwapSlot === item.slot ? null : item.slot)}
                    onPick={(sourceId) => {
                      setOpenSwapSlot(null)
                      onSwap(item.slot, sourceId)
                    }}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      <p className="proposal-total">
        <span>Total</span>
        <span>{formatMoney(money(BigInt(proposal.totalMinor), proposal.currency))}</span>
      </p>

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
          <button type="button" className="btn btn-primary" disabled={pending} onClick={onAccept}>
            Accept
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            aria-expanded={rejecting}
            onClick={() => setRejecting((value) => !value)}
          >
            Reject
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={pending} onClick={() => onShift(-2)}>
            2 days earlier
          </button>
          <button type="button" className="btn btn-sm" disabled={pending} onClick={() => onShift(2)}>
            2 days later
          </button>
          {rejecting ? (
            <div className="reject-reason">
              <label htmlFor={`reject-${proposal.id}`} className="field-label">
                What should change? (optional)
              </label>
              <input
                id={`reject-${proposal.id}`}
                type="text"
                className="input"
                value={rejectReason}
                maxLength={2000}
                placeholder="Closer to the beach, a later flight back..."
                onChange={(event) => setRejectReason(event.target.value)}
              />
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pending}
                  onClick={() => onReject(rejectReason.trim())}
                >
                  Confirm reject
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {proposal.decision === 'accept' && proposal.links.length > 0 ? (
        <ul className="proposal-links">
          {proposal.links.map((link) => (
            <li key={link.itemId}>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                Book for {formatMoney(money(BigInt(link.quotedMinor), link.currency))}
                <ArrowSquareOut size={16} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
}

export type ProposalCardLiveProps = {
  proposal: ProposalRowLite & { links: LinkLite[] }
  alternatives: { flight: AlternativeLite[]; hotel: AlternativeLite[] }
}

const GENERIC_ERROR = 'That could not be sent. Please try again.'
const BUSY_ERROR = 'The desk is already working on this proposal. Give it a moment.'
/**
 * A 429 from decide/revise is the spend ceiling: `submitAction` returns
 * `limit_reached` BEFORE its transaction, so nothing was written, and
 * "please try again" would be advice that cannot work today. Unlike the
 * message box's 429 copy this never says "saved": the card stored nothing.
 */
const LIMIT_ERROR = "Today's spending limit is reached. The desk will pick this up tomorrow."

/**
 * The card's error copy for a non-OK response, a pure function so the
 * status-to-copy mapping is testable without a fetch mock.
 */
export function errorForStatus(status: number): string {
  if (status === 409) return BUSY_ERROR
  if (status === 429) return LIMIT_ERROR
  return GENERIC_ERROR
}

/**
 * The client island: owns the fetch calls to `/api/proposals/[id]/decide`
 * and `/revise` and, on success, calls `router.refresh()`. The
 * conversation's Realtime subscription (`ThreadLive`) does the same on the
 * `working` flip the action turn causes, but refreshing here too disables
 * the buttons immediately rather than after a Realtime round trip.
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
        setError(errorForStatus(res.status))
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
