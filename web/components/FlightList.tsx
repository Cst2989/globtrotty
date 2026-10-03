import { Suitcase, Backpack } from '@phosphor-icons/react/dist/ssr'
import { formatMoney, money } from '@/src/money'
import type { ResultItemLite, LegLite } from '@/web/data'
import { ageText } from './age'

export type FlightListProps = {
  items: ResultItemLite[]
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** The source id already chosen for this slot, if any — renders pinned, with no button. */
  chosenSourceId?: string | null
  onChoose: (sourceId: string) => void
}

function timeHM(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  return m ? `${m[1]}:${m[2]}` : '--:--'
}

/**
 * Whole-day difference between two naive ISO date-times, read from their
 * date portions only (never parsed as a zoned `Date` — the same instinct
 * `web/data.ts`'s `datesFromDetail` documents for this exact field).
 */
function dayOffset(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.slice(0, 10).split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = toIso.slice(0, 10).split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** "07:05 BCN → 10:20+1 HND" — exported so it can be pinned directly in a render test. */
export function legTimeRange(leg: LegLite): string {
  const offset = dayOffset(leg.departureLocal, leg.arrivalLocal)
  const suffix = offset === 0 ? '' : offset > 0 ? `+${offset}` : `${offset}`
  return `${timeHM(leg.departureLocal)} ${leg.from} → ${timeHM(leg.arrivalLocal)}${suffix} ${leg.to}`
}

/** "Nonstop" / "1 stop, DOH" / "2 stops". */
export function stopsWords(stops: number, via: string[]): string {
  if (stops <= 0) return 'Nonstop'
  if (stops === 1) return via[0] ? `1 stop, ${via[0]}` : '1 stop'
  return `${stops} stops`
}

/** "14h 15m". */
export function durationWords(minutes: number): string {
  const h = Math.floor(Math.max(0, minutes) / 60)
  const m = Math.max(0, minutes) % 60
  return `${h}h ${m}m`
}

/**
 * Spec §2.1's flight list: one row per flight item, Kayak-style — airline(s),
 * outbound (and inbound, when round trip) times, stops in words, duration,
 * bag counts, fetched age, price right-aligned, a `Choose` button. A chosen
 * item (`item.sourceId === chosenSourceId`) renders pinned with a `Chosen`
 * label and no button — spec: "`Choose` absent once chosen." Pure (`onChoose`
 * is a callback prop), so `test/web-results-render.test.ts` renders it
 * directly with `renderToStaticMarkup`.
 */
export function FlightList({ items, now, chosenSourceId, onChoose }: FlightListProps) {
  const clock = now ?? new Date()
  return (
    <ul className="flight-list">
      {items.map((item) => {
        const flight = item.flight
        if (!flight) return null
        const chosen = chosenSourceId != null && item.sourceId === chosenSourceId
        return (
          <li key={item.sourceId} className="result-row" data-chosen={chosen}>
            <div className="result-row-main">
              <span className="result-row-airlines">{flight.airlines.join(' / ')}</span>
              <span className="result-row-times">{legTimeRange(flight.outbound)}</span>
              {flight.inbound ? <span className="result-row-times">{legTimeRange(flight.inbound)}</span> : null}
              <span className="result-row-meta">
                {stopsWords(flight.stops, flight.outbound.via)} · {durationWords(flight.durationMinutes)}
                {flight.selfTransfer ? ' · Self-transfer' : ''}
              </span>
              <span className="result-row-bags">
                <Backpack size={16} aria-hidden="true" />
                {flight.bags.cabin}
                <Suitcase size={16} aria-hidden="true" />
                {flight.bags.checked}
              </span>
              <span className="result-row-age">{ageText(item.fetchedAt, clock)}</span>
            </div>
            <div className="result-row-side">
              <span className="result-row-price">{formatMoney(money(BigInt(item.priceMinor), item.currency))}</span>
              {chosen ? (
                <span className="result-row-chosen">Chosen</span>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onChoose(item.sourceId)}>
                  Choose
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
