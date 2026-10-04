import { Star } from '@phosphor-icons/react/dist/ssr'
import { formatMoney, money } from '@/src/money'
import type { ResultItemLite } from '@/web/data'
import { ageText, staleAgeText } from './age'
import { MatchChips } from './MatchChips'
import { AMENITIES, amenityKeysOf, amenityLabel } from '@/src/intake/amenities'

export type HotelCardProps = {
  item: ResultItemLite
  /** The party size the search was for — the price is the whole stay for that party, and the card says so. */
  adults: number
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** True once this stay is the chosen one: a ribbon and no button, same as `FlightCard`. */
  chosen?: boolean
  /** Some OTHER card's Select is in flight, so this one is no longer an offer. */
  selectDisabled?: boolean
  /** A refresh of this card's own search is in flight — its PRICE shimmers, nothing else moves. */
  updating?: boolean
  /**
   * Section 7: the facts about this stay that line up with what she asked for, as green check
   * chips. Empty (or absent) for a stay Jev never checked — see `MatchChips`.
   */
  matches?: string[]
  onChoose: (sourceId: string) => void
}

/** Same two sentences `FlightCard` puts on a disabled Select, for the same two states. */
const UPDATING = 'Updating prices'
const STALE = 'These prices are out of date'

/** How many amenity chips fit on one card before the rest are dropped. */
const MAX_CHIPS = 5

/**
 * Up to `MAX_CHIPS` chips: this office's own word for every amenity it recognises (see
 * `src/intake/amenities.ts` for why the matching is a substring and why that table is shared with
 * the filter), then the supplier's remaining labels verbatim to fill the row out.
 *
 * The chip shows OUR word, not theirs, so twelve spellings of parking read as one fact — and the
 * ones that did not match are not invented, they are simply absent.
 *
 * Pure, and exported so the render tests can pin the matching without a DOM.
 */
export function amenityChips(amenities: string[]): string[] {
  const chips = amenityKeysOf(amenities).map(amenityLabel).slice(0, MAX_CHIPS)
  const matched = new Set(chips.map((c) => c.toLowerCase()))
  for (const amenity of amenities) {
    if (chips.length >= MAX_CHIPS) break
    // Skip a supplier label this office already said in its own words ("Free Wi-Fi" after
    // "Wifi"), which is the one way the filled-out tail can repeat the head.
    if (AMENITIES.some((a) => matched.has(a.label.toLowerCase()) && a.patterns.some((pattern) => amenity.toLowerCase().includes(pattern)))) continue
    chips.push(amenity)
  }
  return chips
}

/** 'Hotel' / 'Apartment', or `null` for a type the supplier did not give a word this office trusts. */
export function typeLabel(propertyType: 'hotel' | 'rental' | 'other'): string | null {
  if (propertyType === 'hotel') return 'Hotel'
  if (propertyType === 'rental') return 'Apartment'
  return null
}

/**
 * `{ word, className }` for a rating, or `null` below 3.5 — Booking's own convention, and the
 * reason the band stops rather than continuing down to "Poor": a chip reading "Poor" beside a
 * Select button is the office editorialising about a property it is simultaneously offering.
 * Below the band the number still shows; only the word is withheld.
 */
export function ratingWord(rating: number): string | null {
  if (rating >= 4.5) return 'Excellent'
  if (rating >= 4.0) return 'Very good'
  if (rating >= 3.5) return 'Good'
  return null
}

/** '4.4' — one decimal, because that is the precision the supplier's own figure deserves. */
export function ratingNumber(rating: number): string {
  return rating.toFixed(1)
}

/** `true` for a nearby place that names an airport, which gets the transit line instead of the area line. */
function isAirport(name: string): boolean {
  return /\bairport\b/i.test(name)
}

/**
 * `true` for a name with at least one letter or digit left in it.
 *
 * SearchApi returns plenty of Tokyo landmarks in Japanese, and the masking this office applies
 * to every supplier string (src/sanitize.ts) turns a name with no ASCII form into a run of `?`.
 * "????? · 12.4 km from centre" is worse than "12.4 km from centre": it looks like the page
 * is broken rather than like an answer that is simply unavailable. So a name that masked to
 * nothing readable is skipped, and the next nearby place — or the distance alone — stands in.
 */
function isReadable(name: string): boolean {
  return /[A-Za-z0-9]/.test(name)
}

/**
 * 'Asakusa - 3.2 km from centre' / 'Asakusa' / '3.2 km from centre', or `null` when the stay
 * carries neither.
 *
 * The AREA is the first nearby place that is not an airport: SearchApi lists the closest things
 * first, so for a city hotel that is the neighbourhood landmark or station beside it — which is
 * what a traveller reads as "where is this". An airport 28 minutes away is not where a hotel is,
 * which is why it gets its own line below.
 */
export function locationLine(
  nearby: { name: string }[], distanceKm: number | null,
): string | null {
  const area = nearby.find((n) => !isAirport(n.name) && isReadable(n.name))?.name ?? null
  const distance = distanceKm === null ? null : `${distanceKm.toFixed(1)} km from centre`
  if (area !== null && distance !== null) return `${area} · ${distance}`
  return area ?? distance
}

/**
 * '28 min to Haneda Airport by taxi', or `null`.
 *
 * Only a nearby AIRPORT with both a duration and a transport word gets this line: the point of
 * it is the arithmetic a traveller would otherwise do herself the moment she sees the flight she
 * just chose, and half of it ("to Haneda Airport") answers nothing.
 */
export function transitLine(
  nearby: { name: string; minutes: number | null; by: string | null }[],
): string | null {
  const airport = nearby.find((n) => isAirport(n.name) && n.minutes !== null && n.by !== null)
  if (!airport) return null
  return `${airport.minutes} min to ${airport.name} by ${airport.by!.toLowerCase()}`
}

/** 'Entire apartment · 1 bedroom · 2 beds' — the supplier's own essentials, nothing added. */
export function essentialsLine(essentials: string[]): string | null {
  return essentials.length === 0 ? null : essentials.join(' · ')
}

/**
 * Filled stars for `stars`, as `n` glyphs with one accessible label.
 *
 * Phosphor glyphs rather than the `'★'.repeat(n)` text `HotelList` used before: the text version
 * is read out as "black star black star black star" by a screen reader and renders in whatever
 * emoji font the platform feels like, which on one of the two platforms this runs on is a colour
 * emoji. `aria-hidden` on the row plus one visually hidden sentence is the honest markup.
 */
function Stars({ stars }: { stars: number }) {
  return (
    <span className="hotel-stars">
      <span aria-hidden="true" className="hotel-stars-glyphs">
        {Array.from({ length: stars }, (_, i) => (
          <Star key={i} size={13} weight="fill" />
        ))}
      </span>
      <span className="visually-hidden">{stars}-star</span>
    </span>
  )
}

/**
 * One stay, as a card: the photo on the left, what the place IS in the middle, and the money and
 * the one button on the right.
 *
 * This replaced a single flat row (`Hotel name  ★★★ · 16 nights · 2026-11-20 → 2026-12-06`),
 * which was the same shape for a capsule hotel and for a five-star tower in Ginza and gave
 * nothing to choose on. The reference is the shape every accommodation search has converged on,
 * because it works: a photo to recognise the place by, a line saying where it is, chips for what
 * it includes, and one column of ratings and prices to scan down.
 *
 * Pure (`onChoose` is a callback prop), so `test/web-results-render.test.ts` renders it directly
 * with `renderToStaticMarkup`. Every string on it is either this file's own English or a
 * supplier label already masked at the adapter boundary (src/supplier/searchapi.ts) and masked
 * again on the way out of the corpus (web/data.ts).
 */
export function HotelCard(
  {
    item, adults, now, chosen = false, selectDisabled = false, updating = false, matches = [],
    onChoose,
  }: HotelCardProps,
) {
  const hotel = item.hotel
  if (!hotel) return null
  const clock = now ?? new Date()
  const photo = hotel.images[0] ?? null
  const type = typeLabel(hotel.propertyType)
  const location = locationLine(hotel.nearby, hotel.distanceKm)
  const transit = transitLine(hotel.nearby)
  const essentials = essentialsLine(hotel.essentials)
  const chips = amenityChips(hotel.amenities)
  const word = hotel.rating === null ? null : ratingWord(hotel.rating)
  const perNight = hotel.pricePerNightMinor === null
    ? null
    : formatMoney(money(BigInt(hotel.pricePerNightMinor), item.currency))

  return (
    <li
      className="hotel-card"
      data-chosen={chosen}
      data-expired={item.expired && !updating ? 'true' : undefined}
      data-flip-id={item.sourceId}
      // Pairs this card with ITSELF across the re-render a refreshed row causes — see
      // `FlightCard` for the whole reasoning and for why the name is scrubbed this way.
      style={{ viewTransitionName: `card-${item.sourceId.replace(/[^A-Za-z0-9]/g, '-')}` }}
    >
      <div className="hotel-card-photo" data-empty={photo === null ? 'true' : 'false'}>
        {/* eslint-disable-next-line @next/next/no-img-element -- `next/image` would proxy a
            Google CDN URL through our own optimiser, which needs a remotePatterns allowlist AND
            puts this office in the business of re-serving someone else's photos; a plain img
            under the CSP's own img-src allowlist is the narrower thing. */}
        {photo !== null ? <img src={photo} alt="" loading="lazy" decoding="async" /> : null}
        {hotel.images.length > 1 ? (
          <span className="hotel-photo-dots" aria-hidden="true">
            {hotel.images.map((image) => <span key={image} className="hotel-photo-dot" />)}
          </span>
        ) : null}
      </div>

      <div className="hotel-card-main">
        {chosen ? <span className="flight-card-ribbon">Selected</span> : null}
        <div className="hotel-card-head">
          <span className="hotel-card-name">{item.name}</span>
          {hotel.stars !== null && hotel.stars > 0 ? <Stars stars={Math.round(hotel.stars)} /> : null}
          {type !== null ? <span className="hotel-card-type">{type}</span> : null}
        </div>
        {location !== null ? <span className="hotel-card-where">{location}</span> : null}
        {transit !== null ? <span className="hotel-card-transit">{transit}</span> : null}
        {chips.length > 0 ? (
          <span className="hotel-chips">
            {chips.map((chip) => <span key={chip} className="hotel-chip">{chip}</span>)}
          </span>
        ) : null}
        {essentials !== null ? <span className="hotel-card-essentials">{essentials}</span> : null}
        <MatchChips matches={matches} />
      </div>

      <div className="hotel-card-side">
        {hotel.rating !== null ? (
          <span className="hotel-rating">
            <span className="hotel-rating-score">{ratingNumber(hotel.rating)}</span>
            {word !== null ? <span className="hotel-rating-word">{word}</span> : null}
          </span>
        ) : null}
        {hotel.reviews !== null && hotel.reviews > 0 ? (
          <span className="hotel-reviews">
            {hotel.reviews} {hotel.reviews === 1 ? 'review' : 'reviews'}
          </span>
        ) : null}
        <span className="hotel-stay">
          {hotel.nights} {hotel.nights === 1 ? 'night' : 'nights'}, {adults}{' '}
          {adults === 1 ? 'adult' : 'adults'}
        </span>
        {updating ? (
          <span className="skeleton-line skeleton-line-price" aria-label="Updating the price" />
        ) : (
          <span className="hotel-card-price">{formatMoney(money(BigInt(item.priceMinor), item.currency))}</span>
        )}
        {!updating && perNight !== null ? (
          <span className="hotel-card-per">{perNight} per night</span>
        ) : null}
        {chosen ? (
          <span className="result-row-chosen">Chosen</span>
        ) : (
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
        <span className="hotel-card-age">
          {updating ? UPDATING : (item.expired ? staleAgeText(item.fetchedAt, clock) : ageText(item.fetchedAt, clock))}
        </span>
      </div>
    </li>
  )
}
