/**
 * Trip-stage pass, section 4: the hotel card's exact layout.
 *
 * Half of this is markup and half of it is the stylesheet, which nothing else in this suite
 * type-checks, imports or renders — so the measurements are read out of `app/globals.css`
 * directly, the same way `test/web-results-render.test.ts` already reads the rules the flight
 * list cannot do without.
 *
 * `.ts`, not `.tsx`: esbuild's `.ts` loader does not parse JSX.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HotelCard } from '../web/components/HotelCard.js'
import { MatchChips, MAX_MATCH_CHIPS, chipsToShow } from '../web/components/MatchChips.js'
import type { ResultItemLite } from '../web/data.js'
import { hotelLite } from './helpers/web-lite.js'

const NOW = new Date('2026-10-04T12:00:00.000Z')

const ITEM: ResultItemLite = {
  sourceId: 'H1', name: 'Agora Tokyo Ginza', priceMinor: '324800', currency: 'EUR',
  fetchedAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(), ttlSeconds: 86_400, expired: false,
  hotel: hotelLite({
    rating: 4.3, nights: 16, stars: 4, reviews: 449, propertyType: 'hotel',
    pricePerNightMinor: '20300', distanceKm: 1.0,
    images: ['https://lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com/b'],
    amenities: ['Wifi', 'Restaurant', 'Accessible'],
    nearby: [
      { name: 'Tsukiji', minutes: null, by: null },
      { name: 'Haneda Airport', minutes: 19, by: 'Taxi' },
    ],
  }),
}

const card = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(
  createElement(HotelCard, { item: ITEM, adults: 2, now: NOW, onChoose: () => {}, ...overrides }),
)

describe('the hotel card, as section 4 spells it', () => {
  it('says where it is and how far the airport is on ONE line', () => {
    const html = card()
    expect(html).toContain('Tsukiji · 1.0 km from centre · 19 min to Haneda Airport by taxi')
    // Two muted grey lines for the same question pushed the chips, the price and the button
    // down the card; there is one element for it now.
    expect([...html.matchAll(/hotel-card-where/g)]).toHaveLength(1)
    expect(html).not.toContain('hotel-card-transit')
  })

  it('says the class in small muted text rather than a bordered uppercase chip', () => {
    const html = card()
    expect(html).toContain('4-star hotel')
    expect(html).toContain('hotel-card-type')
    // The stars beside the name already say it as a picture; a pill shouted the second copy.
    expect(html).not.toContain('text-transform')
  })

  it('draws at most five photo dots, whatever the supplier sent', () => {
    const many = { ...ITEM, hotel: { ...ITEM.hotel!, images: Array.from({ length: 12 }, (_, i) => `https://lh3.googleusercontent.com/${i}`) } }
    const html = card({ item: many })
    expect(html.match(/hotel-photo-dot"/g)).toHaveLength(5)
  })

  it('reads the money column in the order a traveller scans it', () => {
    const html = card()
    const order = ['4.3', 'Very good', '449 reviews', '16 nights, 2 adults', '€3,248', '€203 per night', 'Select', 'found 3 min ago']
    let at = -1
    for (const part of order) {
      const next = html.indexOf(part)
      expect(next, `${part} is missing`).toBeGreaterThan(-1)
      expect(next, `${part} is out of order`).toBeGreaterThan(at)
      at = next
    }
  })

  it('drops the .00 on every price it shows', () => {
    const html = card()
    expect(html).not.toContain('.00')
  })
})

describe('the match chip row', () => {
  it('is ONE row, capped, with the rest as a +N', () => {
    expect(MAX_MATCH_CHIPS).toBe(4)
    const { chips, overflow } = chipsToShow(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(chips.map((c) => c.text)).toEqual(['a', 'b', 'c', 'd'])
    expect(overflow).toBe(2)
  })

  /*
   * A reason NOT to take this option is worth more of a four-chip row than a reason to take it,
   * and it sits in the same row rather than a second one: amber against green is the difference,
   * not the position.
   */
  it('puts the issues first, in the same row, in amber', () => {
    const { chips } = chipsToShow(['Near the centre'], ['Not the cabin you asked for'])
    expect(chips).toEqual([
      { text: 'Not the cabin you asked for', kind: 'issue' },
      { text: 'Near the centre', kind: 'match' },
    ])
    const html = renderToStaticMarkup(createElement(MatchChips, {
      matches: ['Near the centre', 'Well rated', 'Hotel', 'Covers your dates'],
      issues: ['Self-transfer risk'],
    }))
    expect(html).toContain('data-kind="issue"')
    expect(html).toContain('data-kind="match"')
    expect(html).toContain('+1')
    expect([...html.matchAll(/match-chips/g)]).toHaveLength(1)
  })

  it('renders nothing at all for an item nothing checked', () => {
    expect(renderToStaticMarkup(createElement(MatchChips, { matches: [] }))).toBe('')
  })
})

/*
 * The stylesheet is where half of section 4 lives, and nothing else in this suite would notice it
 * changing. These are the measurements the brief names, read straight out of the file.
 */
describe('the stylesheet rules the hotel card cannot do without', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

  function block(selector: string): string {
    const at = css.indexOf(`\n${selector} {`)
    expect(at, `${selector} has no rule of its own`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('is a three-column grid with the sizes the brief names', () => {
    const rule = block('.hotel-card')
    expect(rule).toContain('display: grid')
    expect(rule).toContain('grid-template-columns: 200px minmax(0, 1fr) 180px')
    expect(rule).toContain('gap: 20px')
    expect(rule).toContain('padding: 16px')
    expect(rule).toContain('align-items: start')
  })

  it('gives the photo 200x150 and a 12px radius', () => {
    const rule = block('.hotel-card-photo')
    expect(rule).toContain('width: 200px')
    expect(rule).toContain('height: 150px')
    expect(rule).toContain('border-radius: 12px')
    expect(block('.hotel-card-photo img')).toContain('object-fit: cover')
  })

  it('lets the middle column be narrower than its content, so line 2 can ellipsise', () => {
    expect(block('.hotel-card-main')).toContain('min-width: 0')
    const where = block('.hotel-card-where')
    expect(where).toContain('white-space: nowrap')
    expect(where).toContain('text-overflow: ellipsis')
    expect(where).toContain('font-size: 13px')
  })

  it('balances the name over at most two lines', () => {
    const rule = block('.hotel-card-name')
    expect(rule).toContain('font-size: 18px')
    expect(rule).toContain('font-weight: 600')
    expect(rule).toContain('text-wrap: balance')
    expect(rule).toContain('-webkit-line-clamp: 2')
  })

  it('puts 6px between the lines', () => {
    expect(block('.hotel-card-main')).toContain('gap: 6px')
  })

  it('draws the money column right-aligned with NO vertical divider', () => {
    const rule = block('.hotel-card-side')
    expect(rule).toContain('text-align: right')
    expect(rule).not.toContain('border-left')
    expect(block('.hotel-card-price')).toContain('font-size: 22px')
    expect(block('.hotel-card-price')).toContain('font-weight: 700')
    expect(block('.hotel-rating-score')).toContain('font-size: 13px')
    expect(block('.hotel-reviews')).toContain('font-size: 12px')
    expect(block('.hotel-card-age')).toContain('font-size: 11px')
    expect(block('.hotel-card-side .btn')).toContain('height: 40px')
    expect(block('.hotel-card-side .btn')).toContain('width: 100%')
  })

  it('gives the stars 14px of amber', () => {
    const rule = block('.hotel-stars-glyphs')
    expect(rule).toContain('font-size: 14px')
    expect(rule).toContain('color: var(--star)')
  })

  /*
   * A CONTAINER query, not a viewport one: beside a map the list is 55% of the pane, so a media
   * query would stack the cards on a wide laptop and leave them three-column on a narrow one.
   */
  it('restacks on the LIST\'s width, at 720px, with a 16:10 photo on top', () => {
    expect(block('.hotel-split-list')).toContain('container-type: inline-size')
    // The literal query, not the comment above `.hotel-split-list` that names it.
    const at = css.indexOf('\n@container (max-width: 720px)')
    expect(at).toBeGreaterThan(-1)
    const query = css.slice(at, css.indexOf('\n}', at))
    expect(query).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(query).toContain('aspect-ratio: 16 / 10')
  })

  it('draws the chips as one flowing 12px row, amber for an issue', () => {
    expect(block('.match-chips')).toContain('flex-wrap: wrap')
    expect(block('.match-chip')).toContain('font-size: 12px')
    expect(block('.hotel-chip')).toContain('font-size: 12px')
    expect(css).toContain(".match-chip[data-kind='issue']")
  })
})
