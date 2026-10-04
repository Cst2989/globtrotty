import { Backpack, Bag, Suitcase, Warning } from '@phosphor-icons/react/dist/ssr'
import { formatMoney, money } from '@/src/money'
import type { ResultItemLite, LegLite } from '@/web/data'
import { AirlineLogo } from './AirlineLogo'
import { MatchChips } from './MatchChips'
import { ageText, staleAgeText } from './age'

export type FlightCardProps = {
  item: ResultItemLite
  /** The party size the search was for — the price is a party total, and the card says so. */
  adults: number
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** True once this item is the chosen flight: a `Selected` ribbon and no button. */
  chosen?: boolean
  /** Pass 3, section 6a: some OTHER card's Select is in flight, so this one is no longer an offer. */
  selectDisabled?: boolean
  /**
   * Pass 3 (author's correction to section 1): a refresh of this card's own search is in flight,
   * so its PRICE is a shimmering block rather than a number. Everything else about the itinerary
   * — the legs, the times, the stops, the bags, the carriers — is as true as it was, so it stays
   * exactly where it is; the one thing a ttl expires is the money.
   */
  updating?: boolean
  /**
   * Section 7: the facts about this itinerary that line up with what she asked for, as green
   * check chips. Empty (or absent) for an item Jev never checked — see `MatchChips`.
   */
  matches?: string[]
  onChoose: (sourceId: string) => void
}

/** 'HH:MM' off a naive ISO local time, never through `Date` — the rule for every supplier timestamp. */
export function timeHM(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  return m ? `${m[1]}:${m[2]}` : '--:--'
}

/**
 * Whole-day difference between two naive ISO date-times, read from their date portions only
 * (never parsed as a zoned `Date`). This is what puts the `+1` on an arrival time.
 */
export function dayOffset(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.slice(0, 10).split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = toIso.slice(0, 10).split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/**
 * 'Direct' / '1 stop, Shanghai' / '2 stops, Shanghai, Doha' — the CITIES a leg connects through,
 * not their airport codes, because "1 stop, PVG" tells a traveller nothing she can picture.
 *
 * `viaCities` and `via` are the same length and order (`web/data.ts`), so a city that resolved and
 * a code that did not sit side by side without the list going out of step. A stop count the
 * supplier gave without naming the airport prints the count alone.
 */
export function stopsWords(stops: number, viaCities: string[]): string {
  if (stops <= 0) return 'Direct'
  const noun = stops === 1 ? '1 stop' : `${stops} stops`
  return viaCities.length > 0 ? `${noun}, ${viaCities.join(', ')}` : noun
}

/** '22h 25m'. */
export function durationWords(minutes: number): string {
  const h = Math.floor(Math.max(0, minutes) / 60)
  const m = Math.max(0, minutes) % 60
  return `${h}h ${m}m`
}

/**
 * Pass 3: an expired card's Select says why it is disabled rather than just being dead. Pressing
 * it could never have worked anyway — the freshness gate (src/gates/freshnessGate.ts) rejects a
 * proposal built on an expired price.
 *
 * `UPDATING` is the ordinary case and lasts a few seconds: the pane re-runs the search by itself
 * the moment it notices the prices have aged out. `STALE` is what is left when that re-run
 * failed, which is the one state with nothing useful to offer her but the truth.
 */
const UPDATING = 'Updating prices'
const STALE = 'These prices are out of date'

/** How many carrier logos fit on one leg's line before the rest become a `+N`. */
const MAX_LOGOS = 2

/**
 * One leg of an itinerary, read left to right the way every flight-search result reads it:
 * departure time over its airport code, then a horizontal rule carrying the leg's duration above
 * it, the operating carrier's logo centred on it and the stops under it, then the arrival time
 * over its code with a `+1` superscript whenever the aircraft lands on a later calendar day.
 *
 * `label` ('Outbound' / 'Inbound') is a visible row label rather than a heading, because the two
 * rows are two halves of ONE priced thing and a heading each would say otherwise.
 */
function LegRow({ label, leg, stops }: { label: string; leg: LegLite; stops: number }) {
  const offset = dayOffset(leg.departureLocal, leg.arrivalLocal)
  const logos = leg.carriers.slice(0, MAX_LOGOS)
  const extraCarriers = leg.carriers.length - logos.length

  return (
    <div className="leg-row">
      <span className="leg-label">{label}</span>
      <div className="leg-end">
        <span className="leg-time">{timeHM(leg.departureLocal)}</span>
        <span className="leg-code">{leg.from}</span>
      </div>
      <div className="leg-middle">
        <span className="leg-duration">{durationWords(leg.durationMinutes)}</span>
        <span className="leg-rule">
          <span className="leg-carriers">
            {logos.map((code, i) => (
              <AirlineLogo key={code} code={code} name={leg.carrierNames[i] ?? code} />
            ))}
            {extraCarriers > 0 ? <span className="leg-carriers-more">+{extraCarriers}</span> : null}
          </span>
        </span>
        <span className="leg-stops" data-direct={stops <= 0 ? 'true' : 'false'}>
          {stopsWords(stops, leg.viaCities)}
        </span>
      </div>
      <div className="leg-end leg-end-arrive">
        <span className="leg-time">
          {timeHM(leg.arrivalLocal)}
          {offset > 0 ? <sup className="leg-day-offset">+{offset}</sup> : null}
          {offset < 0 ? <sup className="leg-day-offset">{offset}</sup> : null}
        </span>
        <span className="leg-code">{leg.to}</span>
      </div>
    </div>
  )
}

/**
 * One flight, as a card: the legs on the left, the money and the one button on the right.
 *
 * This replaced a single flat row of text (`07:05 BCN → 10:20+1 HND · 1 stop, DOH · 14h 15m`),
 * which made every itinerary look identical at a glance and gave nothing to compare on. The
 * reference is the shape every flight search has converged on, because it works: a traveller
 * scans one column of times, one column of durations, one column of prices, and the thing she
 * actually decides on — "how long, how many stops, how much" — lines up vertically down the list.
 *
 * Pure (`onChoose` is a callback prop), so `test/web-results-render.test.ts` renders it directly
 * with `renderToStaticMarkup`. `AirlineLogo` is the one client island inside it, for its
 * `onError` fallback alone.
 */
export function FlightCard(
  {
    item, adults, now, chosen = false, selectDisabled = false, updating = false, matches = [],
    onChoose,
  }: FlightCardProps,
) {
  const flight = item.flight
  if (!flight) return null
  const clock = now ?? new Date()

  return (
    <li
      className="flight-card"
      data-chosen={chosen}
      data-expired={item.expired && !updating ? 'true' : undefined}
      // What `useListFlip` (web/components/flip.ts) tracks this card's position by.
      data-flip-id={item.sourceId}
      // Pass 3: pairs this card with ITSELF across the re-render the refreshed row causes, so a
      // card that Jev's new ranking moves up the list animates to its new place instead of the
      // whole list redrawing. Keyed on the supplier's own id, with every character a
      // `view-transition-name` cannot carry replaced — the name only has to be unique in the
      // document, never readable.
      style={{ viewTransitionName: `card-${item.sourceId.replace(/[^A-Za-z0-9]/g, '-')}` }}
    >
      <div className="flight-card-main">
        {chosen ? <span className="flight-card-ribbon">Selected</span> : null}
        <LegRow label="Outbound" leg={flight.outbound} stops={flight.stops} />
        {flight.inbound ? (
          <LegRow label="Inbound" leg={flight.inbound} stops={flight.inboundStops ?? 0} />
        ) : null}
        <MatchChips matches={matches} />
        <div className="flight-card-extras">
          <span className="flight-bags">
            <span className="flight-bag" data-included={flight.bags.personal > 0 ? 'true' : 'false'}>
              <Backpack size={16} aria-hidden="true" />
              {flight.bags.personal}
              <span className="visually-hidden"> personal items included</span>
            </span>
            <span className="flight-bag" data-included={flight.bags.cabin > 0 ? 'true' : 'false'}>
              <Bag size={16} aria-hidden="true" />
              {flight.bags.cabin}
              <span className="visually-hidden"> cabin bags included</span>
            </span>
            <span className="flight-bag" data-included={flight.bags.checked > 0 ? 'true' : 'false'}>
              <Suitcase size={16} aria-hidden="true" />
              {flight.bags.checked}
              <span className="visually-hidden"> checked bags included</span>
            </span>
          </span>
          {flight.selfTransfer ? (
            <span className="flight-self-transfer">
              <Warning size={16} aria-hidden="true" />
              Self-transfer: a missed connection is not covered
            </span>
          ) : null}
        </div>
      </div>
      <div className="flight-card-side">
        {updating ? (
          <span className="skeleton-line skeleton-line-price" aria-label="Updating the price" />
        ) : (
          <span className="flight-card-price">{formatMoney(money(BigInt(item.priceMinor), item.currency))}</span>
        )}
        <span className="flight-card-per">for {adults} {adults === 1 ? 'passenger' : 'passengers'}</span>
        {chosen ? null : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={item.expired || selectDisabled}
            title={updating ? UPDATING : (item.expired ? STALE : undefined)}
            onClick={() => onChoose(item.sourceId)}
          >
            Select
          </button>
        )}
        <span className="flight-card-age">
          {updating ? UPDATING : (item.expired ? staleAgeText(item.fetchedAt, clock) : ageText(item.fetchedAt, clock))}
        </span>
      </div>
    </li>
  )
}
