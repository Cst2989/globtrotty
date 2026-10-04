'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowSquareOut, CaretDown } from '@phosphor-icons/react'
import { formatMoneyShort, money } from '@/src/money'
import type { ProposalItemLite, ProposalRowLite, LinkLite } from '@/web/data'
import { dayMonth } from './SummaryBar'
import { errorForStatus } from './errors'
import { useOptimistic } from './optimistic'

export type TripProposal = ProposalRowLite & { links: LinkLite[] }

/**
 * Trip-stage pass, section 3: what the CHAT says about a trip.
 *
 * The screenshots at 16.23 are the whole brief for this file. Two `Proposed trip` cards were
 * stacked in the thread — the combined one with its Accept/Reject buttons, and under it the
 * flights-only proposal `handleChooseFlight` writes and accepts on the spot, rendered as a
 * second card with its own `Total €5,064` that was not the total of anything. Each item also
 * carried a `Swap` picker, which is a third way of choosing a flight on a screen that already
 * has two, and the card repeated, word for word, the pinned block in the pane beside it.
 *
 * So: one card, for the newest proposal that is actually a TRIP, and every earlier one collapsed
 * to a line. The pane owns the cards and the totals; the chat owns the decision.
 */

/** A proposal holds a stay — the only kind that is a trip rather than a recorded flight choice. */
export function isTrip(proposal: ProposalRowLite): boolean {
  return proposal.items.some((i) => i.kind === 'hotel')
}

/**
 * Which proposal the chat draws as a card, and which collapse under `Earlier proposals (n)`.
 *
 * The newest TRIP is the card. A flights-only proposal is never one: it is how the office
 * remembers which flight she picked, the pane is already showing it pinned with its own ribbon,
 * and a `Your trip` heading over a single flight claims a trip that does not exist yet.
 *
 * Pure, so `test/web-trip-card.test.ts` pins it without rendering anything.
 */
export function splitProposals(
  proposals: TripProposal[],
): { current: TripProposal | null; earlier: TripProposal[] } {
  const current = proposals.find(isTrip) ?? null
  return { current, earlier: proposals.filter((p) => p !== current) }
}

/** `19 Nov to 6 Dec`, or `19 Nov` for a one-way. Nothing at all when the dates are missing. */
export function datesLine(item: ProposalItemLite): string | null {
  if (!item.outbound) return null
  return item.inbound ? `${dayMonth(item.outbound)} to ${dayMonth(item.inbound)}` : dayMonth(item.outbound)
}

/**
 * One item, as the one line section 3 asks for:
 * `Flight · China Eastern · 19 Nov to 6 Dec · €5,064`
 * `Stay · Agora Tokyo Ginza · 16 nights · €3,248`
 *
 * The flight is named by its CARRIER and the stay by its own name, because that is what each one
 * is to a traveller — `BCN-NRT` is a database row read aloud. A part this office cannot resolve
 * simply drops out rather than leaving a gap.
 *
 * Exported so the render tests pin the wording without walking markup.
 */
export function itemLine(item: ProposalItemLite): string[] {
  const parts: string[] = [item.kind === 'flight' ? 'Flight' : 'Stay']
  if (item.kind === 'flight') {
    if (item.airline) parts.push(item.airline)
    else if (item.name) parts.push(item.name)
  } else if (item.name) {
    parts.push(item.name)
  }
  if (item.kind === 'hotel' && item.nights !== null) {
    parts.push(`${item.nights} ${item.nights === 1 ? 'night' : 'nights'}`)
  }
  const dates = datesLine(item)
  if (dates) parts.push(dates)
  parts.push(formatMoneyShort(money(BigInt(item.priceMinor), item.currency)))
  return parts
}

/** `Trip proposed · €8,312` — what an earlier proposal collapses to. A marker, not a card. */
export function proposalMarker(proposal: TripProposal): string {
  return `Trip proposed · ${formatMoneyShort(money(BigInt(proposal.totalMinor), proposal.currency))}`
}

function statusWords(decision: 'accept' | 'reject' | null): string {
  if (decision === 'accept') return 'Accepted'
  return decision === 'reject' ? 'Rejected' : 'Waiting for your decision'
}

export type TripCardProps = {
  proposal: TripProposal
  pending: boolean
  error: string | null
  onAccept: () => void
  onReject: (reason: string) => void
  onShift: (days: -2 | 2) => void
  /** `Change the flight` / `Change the hotel` — posted as her own words, like any other chip. */
  onChange: (what: 'flight' | 'hotel') => void
}

/**
 * The decision card. Pure (every decision is a callback prop), so
 * `test/web-trip-card.test.ts` renders it with `renderToStaticMarkup`.
 */
export function TripCard(
  { proposal, pending, error, onAccept, onReject, onShift, onChange }: TripCardProps,
) {
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const decided = proposal.decision !== null
  const accepted = proposal.decision === 'accept'

  return (
    <article className="trip-card" data-decision={proposal.decision ?? 'pending'} aria-label="Your trip">
      <div className="trip-card-head">
        <h2>Your trip</h2>
        <span className="trip-card-status" data-decision={proposal.decision ?? 'pending'}>
          {statusWords(proposal.decision)}
        </span>
      </div>

      <ul className="trip-card-items">
        {proposal.items.map((item) => (
          <li key={item.slot} className="trip-card-item">{itemLine(item).join(' · ')}</li>
        ))}
      </ul>

      <p className="trip-card-total">
        <span>Total</span>
        <span>{formatMoneyShort(money(BigInt(proposal.totalMinor), proposal.currency))}</span>
      </p>

      {proposal.gateOutcome === 'shipped_unapproved' && proposal.reviewIssues.length > 0 ? (
        <div className="trip-card-issues">
          <p>The reviewer flagged this trip:</p>
          <ul>
            {proposal.reviewIssues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ) : null}

      {!decided ? (
        <>
          <div className="trip-card-actions">
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
          </div>
          {/* Section 3's four chips. No Swap picker: choosing a flight happens on a flight card,
              in the pane, where the flights are. */}
          <div className="next-chips" role="group" aria-label="Change the trip">
            <button type="button" className="suggestion" disabled={pending} onClick={() => onChange('flight')}>
              Change the flight
            </button>
            <button type="button" className="suggestion" disabled={pending} onClick={() => onChange('hotel')}>
              Change the hotel
            </button>
            <button type="button" className="suggestion" disabled={pending} onClick={() => onShift(-2)}>
              2 days earlier
            </button>
            <button type="button" className="suggestion" disabled={pending} onClick={() => onShift(2)}>
              2 days later
            </button>
          </div>
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
        </>
      ) : null}

      {accepted && proposal.links.length > 0 ? <BookingLinks proposal={proposal} /> : null}

      {error ? <p className="alert" role="alert">{error}</p> : null}
    </article>
  )
}

/**
 * Section 3's end of the conversation: the office says the links are ready and offers them as the
 * same ghost chips every other suggestion uses. `target="_blank"` and `rel="noopener noreferrer"`
 * on every one — spec §6's "the only anchors are `link_clicks.url`".
 */
export function BookingLinks({ proposal }: { proposal: TripProposal }) {
  const byKind = new Map(proposal.items.map((i) => [i.sourceId, i.kind]))
  return (
    <div className="trip-card-links">
      <p className="trip-card-links-note">Your links are ready</p>
      <div className="next-chips" role="group" aria-label="Book the trip">
        {proposal.links.map((link) => (
          <a
            key={link.itemId}
            className="suggestion"
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {byKind.get(link.itemId) === 'flight' ? 'Book the flight' : 'Book the hotel'}
            <ArrowSquareOut size={14} aria-hidden="true" />
          </a>
        ))}
      </div>
    </div>
  )
}

/** Every proposal before the current one, as one line each behind a disclosure. */
export function EarlierProposals({ proposals }: { proposals: TripProposal[] }) {
  const [open, setOpen] = useState(false)
  if (proposals.length === 0) return null
  return (
    <div className="earlier-proposals">
      <button
        type="button"
        className="unmatched-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <CaretDown size={14} aria-hidden="true" data-open={open ? 'true' : 'false'} />
        Earlier proposals ({proposals.length})
      </button>
      {open ? (
        <ul className="earlier-proposals-list">
          {proposals.map((p) => (
            <li key={p.id} className="message message-action">{proposalMarker(p)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export type TripCardLiveProps = {
  conversationId: string
  /** `loadProposals`'s own newest-first list. */
  proposals: TripProposal[]
}

const GENERIC_ERROR = 'That could not be sent. Please try again.'

/**
 * The client island: the decision requests, and the optimistic writes that go with them.
 *
 * Accept writes a pending `accept` to the shared store BEFORE its POST, which is what puts
 * `You accepted the trip` in the thread and turns the pane's action area into
 * `Checking prices and getting your booking links…` in the same tick — one store, both halves
 * (`web/components/optimistic.tsx`).
 */
export function TripCardLive({ conversationId, proposals }: TripCardLiveProps) {
  const router = useRouter()
  const optimistic = useOptimistic()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { current, earlier } = splitProposals(proposals)

  async function post(path: 'decide' | 'revise', body: unknown, onFail?: () => void) {
    if (!current) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/proposals/${current.id}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(errorForStatus(res.status))
        onFail?.()
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
      onFail?.()
    } finally {
      setPending(false)
    }
  }

  /** `Change the flight` / `Change the hotel`: her own words, posted the way a chip's are. */
  async function sendChange(what: 'flight' | 'hotel') {
    const label = what === 'flight' ? 'Change the flight' : 'Change the hotel'
    const idempotencyKey = crypto.randomUUID()
    const entry = optimistic.add({ kind: 'message', text: label, idempotencyKey })
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: label, idempotencyKey }),
      })
      if (!res.ok) {
        setError(errorForStatus(res.status))
        optimistic.fail(entry)
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
      optimistic.fail(entry)
    } finally {
      setPending(false)
    }
  }

  if (!current) return <EarlierProposals proposals={earlier} />

  return (
    <>
      <EarlierProposals proposals={earlier} />
      <TripCard
        proposal={current}
        pending={pending}
        error={error}
        onAccept={() => {
          const entry = optimistic.add({ kind: 'accept', text: '', sourceId: current.id })
          void post('decide', { decision: 'accept' }, () => optimistic.fail(entry))
        }}
        onReject={(reason) => void post('decide', { decision: 'reject', ...(reason ? { rejectReason: reason } : {}) })}
        onShift={(days) => void post('revise', { kind: 'shift', days })}
        onChange={(what) => void sendChange(what)}
      />
    </>
  )
}
