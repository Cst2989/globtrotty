import { ArrowSquareOut } from '@phosphor-icons/react/dist/ssr'
import { formatMoney, money } from '@/src/money'
import type { ProposalItemLite, LinkLite } from '@/web/data'

export type PinnedSummaryProps = {
  /** The chosen flight and/or hotel items (0 to 2) recorded so far — `web/data.ts`'s `ProposalItemLite`. */
  items: ProposalItemLite[]
  totalMinor: string
  currency: string
  decision: 'accept' | 'reject' | null
  /** Already scoped to an accepted proposal by `web/data.ts`'s `loadProposals` — the only anchors this component renders. */
  links: LinkLite[]
  pending: boolean
  error: string | null
  onGetLinks: () => void
}

/**
 * Spec §2.4's pinned summary: the chosen flight and hotel, a total, and the
 * existing hand-off button once something is chosen. `Get booking links`
 * shows only while `decision` is `null`; once accepted, the tracked links
 * (spec §6: "only anchors are `link_clicks.url`") replace it — the same
 * contract `ProposalCard` already follows. Pure (`onGetLinks` is a callback
 * prop), so `test/web-results-render.test.ts` can render it directly with
 * `renderToStaticMarkup`.
 */
export function PinnedSummary({ items, totalMinor, currency, decision, links, pending, error, onGetLinks }: PinnedSummaryProps) {
  return (
    <section className="pinned-summary" aria-label="Your trip so far">
      <ul className="pinned-items">
        {items.map((item) => (
          <li key={item.slot} className="pinned-item">
            <span className="pinned-item-name">{item.name}</span>
            {item.dates ? <span className="pinned-item-dates">{item.dates}</span> : null}
            <span className="pinned-item-price">{formatMoney(money(BigInt(item.priceMinor), item.currency))}</span>
          </li>
        ))}
      </ul>
      <p className="pinned-total">
        <span>Total</span>
        <span>{formatMoney(money(BigInt(totalMinor), currency))}</span>
      </p>
      {decision === null ? (
        // Pass 3, section 6d: the label changes in the tick she presses it. The hand-off re-checks
        // every price with the supplier before it mints a link (src/tools/cashier.ts), which takes
        // seconds, and an unchanged button through all of them reads as a button that did nothing.
        <button type="button" className="btn btn-primary" disabled={pending} onClick={onGetLinks}>
          {pending ? 'Checking prices…' : 'Get booking links'}
        </button>
      ) : decision === 'accept' && links.length > 0 ? (
        <ul className="pinned-links">
          {links.map((link) => (
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
    </section>
  )
}
