import { ArrowSquareOut } from '@phosphor-icons/react/dist/ssr'
import { formatMoney, money } from '@/src/money'
import type { ProposalItemLite, LinkLite } from '@/web/data'
import { weekdayDayMonth } from './SummaryBar'
import { ageWords } from './age'
import { Stars } from './HotelCard'

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
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  onGetLinks: () => void
}

/**
 * The status chip. `decision` is the proposal's own field, so these are the only three states.
 *
 * It is a chip rather than a line of prose because it is the one thing on this block she might
 * want to check at a glance, and because "Accepted" floating in a paragraph reads as a claim
 * about the trip rather than as its state.
 */
function statusLabel(decision: 'accept' | 'reject' | null): string {
  if (decision === 'accept') return 'Accepted'
  return decision === 'reject' ? 'Rejected' : 'Waiting for your decision'
}

/**
 * Polish pass, section 4: the flight, in the words a traveller uses.
 *
 * `Barcelona BCN → Tokyo NRT · Thu 19 Nov to Sun 6 Dec · China Eastern`, against the
 * `BCN-NRT` / `2026-11-19 → 2026-12-06` the summary used to print. Every part is resolved from
 * this office's own tables (airport-to-city, carrier-to-name) or computed (`weekdayDayMonth`,
 * the same formatter the summary bar above the list uses, so one date is written one way on this
 * screen). A field that is missing simply drops out of the line rather than leaving a gap.
 *
 * Exported so `test/web-results-render.test.ts` can pin the wording without walking markup.
 */
export function flightLine(item: ProposalItemLite): string[] {
  const parts: string[] = []
  if (item.route) {
    const from = item.route.fromCity ? `${item.route.fromCity} ${item.route.from}` : item.route.from
    const to = item.route.toCity ? `${item.route.toCity} ${item.route.to}` : item.route.to
    parts.push(`${from} → ${to}`)
  }
  if (item.outbound) {
    parts.push(item.inbound
      ? `${weekdayDayMonth(item.outbound)} to ${weekdayDayMonth(item.inbound)}`
      : `${weekdayDayMonth(item.outbound)}, one way`)
  }
  // Not when it is already the name on the row above. A Kiwi flight's `name` IS its carrier, so
  // this line read "China Eastern · Barcelona BCN → Tokyo NRT · ... · China Eastern" — which the
  // screenshot caught and no test would have. Compared loosely, because the two come from
  // different places: the supplier's own string and this office's airline table, which may say
  // "China Eastern Airlines" for the same carrier.
  if (item.airline && !saysTheSame(item.name, item.airline)) parts.push(item.airline)
  return parts
}

/** Whether one of these two names contains the other, ignoring case and spacing. */
function saysTheSame(a: string, b: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim()
  const [x, y] = [norm(a), norm(b)]
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x))
}

/** The stay's own line: how long, for a stay whose name and class are already on the row above. */
export function stayLine(item: ProposalItemLite): string[] {
  const parts: string[] = []
  if (item.nights !== null) parts.push(`${item.nights} ${item.nights === 1 ? 'night' : 'nights'}`)
  if (item.outbound && item.inbound) {
    parts.push(`${weekdayDayMonth(item.outbound)} to ${weekdayDayMonth(item.inbound)}`)
  }
  return parts
}

/**
 * `Prices checked 3 h ago`, and ONLY once the quote is past its own ttl.
 *
 * The old line said `found 3 h ago` on every summary whatever its age, which is a fact about our
 * corpus dressed up as a warning. An age is worth her attention exactly when the price behind it
 * may have moved, and silent otherwise. `null` when the item carries no ttl to judge it by —
 * saying nothing beats guessing.
 */
export function priceAgeNote(item: ProposalItemLite, now: Date): string | null {
  if (item.ttlSeconds === null) return null
  const fetchedAt = new Date(item.fetchedAt).getTime()
  if (fetchedAt + item.ttlSeconds * 1000 > now.getTime()) return null
  return `Prices checked ${ageWords(item.fetchedAt, now)} ago`
}

/**
 * Spec section 2.4's pinned summary: what she has chosen, a total, and the hand-off button.
 *
 * Polish pass, section 4 rewrote what it SAYS. It read `BCN-NRT`, `2026-11-19 → 2026-12-06`,
 * `found 3 h ago` — the itinerary row printed out, in the one place on the screen whose whole
 * job is to tell her what she has decided. Now the flight reads as a route, a pair of weekday
 * dates and a carrier; the stay reads as its name with its class and length of stay; and the
 * decision is a chip rather than a word floating beside a heading.
 *
 * `Get booking links` shows only while `decision` is `null`; once accepted, the tracked links
 * (spec section 6: "only anchors are `link_clicks.url`") replace it — the same contract
 * `ProposalCard` already follows. Pure (`onGetLinks` is a callback prop), so
 * `test/web-results-render.test.ts` can render it directly with `renderToStaticMarkup`.
 */
export function PinnedSummary(
  { items, totalMinor, currency, decision, links, pending, error, now, onGetLinks }: PinnedSummaryProps,
) {
  const clock = now ?? new Date()
  const ages = items.map((i) => priceAgeNote(i, clock)).filter((a): a is string => a !== null)

  return (
    <section className="pinned-summary" aria-label="Your trip so far">
      <div className="pinned-head">
        <h2 className="pinned-heading">Proposed trip</h2>
        <span className="pinned-status" data-decision={decision ?? 'pending'}>
          {statusLabel(decision)}
        </span>
      </div>
      <ul className="pinned-items">
        {items.map((item) => {
          const line = item.kind === 'flight' ? flightLine(item) : stayLine(item)
          return (
            <li key={item.slot} className="pinned-item">
              <span className="pinned-item-head">
                <span className="pinned-item-name">{item.name}</span>
                {item.stars !== null ? <Stars stars={Math.round(item.stars)} /> : null}
              </span>
              {line.length > 0 ? (
                <span className="pinned-item-dates">{line.join(' · ')}</span>
              ) : null}
              <span className="pinned-item-price">
                {formatMoney(money(BigInt(item.priceMinor), item.currency))}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="pinned-total">
        <span>Total</span>
        <span>{formatMoney(money(BigInt(totalMinor), currency))}</span>
      </p>
      {/* Said once for the whole block, and only when something in it has actually aged out. */}
      {ages.length > 0 ? <p className="pinned-age">{ages[0]}</p> : null}
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
