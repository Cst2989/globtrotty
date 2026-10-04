'use client'

import { useEffect, useRef } from 'react'
// Type-only, so nothing of Leaflet is evaluated during this module's own import — which Next
// does on the server even for a client component. The VALUE import is inside the effect.
import type * as Leaflet from 'leaflet'
import { formatMoney, money } from '@/src/money'
import type { ResultItemLite } from '@/web/data'
// Bundled from node_modules rather than fetched from a CDN, which is what keeps `style-src` at
// `'self'` and means a map renders with no third-party request but the tiles themselves.
import 'leaflet/dist/leaflet.css'

export type HotelMapProps = {
  items: ResultItemLite[]
  /** The destination city's own centre: the small ring, and part of the initial bounds. */
  centre: { lat: number; lon: number } | null
  /** The stay already chosen, if any — its pill takes the accent colour. */
  chosenSourceId?: string | null
  /** The card she is hovering, whose pill lifts to match. */
  highlightedSourceId?: string | null
  /** Clicking a pill scrolls to that card and highlights it. */
  onPick: (sourceId: string) => void
}

/**
 * CARTO's dark basemap, and the attribution both CARTO and OpenStreetMap's licence require; the
 * origin is pinned in web/csp.ts.
 *
 * OSM's own tile servers answer this app with a 403 and an "Access blocked" tile: their usage
 * policy is written for a named, contactable application, not for an anonymous deployment, and
 * the correct fix is a CDN that exists to serve applications rather than arguing with it. CARTO's
 * dark_all is also the right PICTURE for this page: a light street map under a dark page was a
 * white rectangle shouting beside the list.
 */
export const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
export const TILE_SUBDOMAINS = 'abcd'
export const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO'

/**
 * `&`, `<`, `>`, `"` and `'` as entities.
 *
 * Leaflet's `divIcon` takes an HTML STRING — there is no React escaping on that path, which is
 * the one place in this project where a supplier-derived value would be interpolated into markup
 * raw. `priceMinor` is a decimal string by the time it reaches here (`web/data.ts` refuses
 * anything else) and `formatMoney` only ever emits digits, separators and a currency symbol, so
 * this escape has nothing to do today. It is here because the NEXT person to put a name or a
 * label on a pill will reach for the same function, and because defence that only exists once
 * the hole does is not defence.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The HTML for one price pill: `€1,137`. Pure, and exported so the render tests can pin the
 * escaping without a DOM or a map.
 *
 * `active` is the chosen or hovered pin, which takes the accent colour so the one pin she is
 * thinking about is findable among forty.
 */
export function pricePillHtml(priceMinor: string, currency: string, active: boolean): string {
  const text = formatMoney(money(BigInt(priceMinor), currency))
  return `<span class="map-pill" data-active="${active ? 'true' : 'false'}">${escapeHtml(text)}</span>`
}

/** The ring marking the city centre — the thing every distance on a card is measured from. */
const CENTRE_PIN_HTML = '<span class="map-centre" aria-hidden="true"></span>'

/**
 * The Airbnb-style map beside the list: one price pill per stay, a ring on the city centre, and
 * the whole thing fitted to the pins it has.
 *
 * `'use client'` and loaded through `next/dynamic` with `ssr: false` by `ResultsPane`, because
 * Leaflet touches `window` at import time and would throw during a server render. Leaflet itself
 * is imported dynamically INSIDE the effect for the same reason — a top-level `import 'leaflet'`
 * runs during the module's own evaluation, which Next does on the server even for a client
 * component.
 *
 * The imperative shape (a ref, an effect, markers held outside React) is Leaflet's, not a
 * preference: it owns its own DOM, and re-rendering a map through React's reconciler would mean
 * tearing down and rebuilding every marker on every hover.
 */
export function HotelMap(
  { items, centre, chosenSourceId = null, highlightedSourceId = null, onPick }: HotelMapProps,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Leaflet.Map | null>(null)
  const markersRef = useRef<Map<string, Leaflet.Marker>>(new Map())
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  const placed = items.filter((i) => i.hotel?.coordinates)
  // What the effect below keys on: rebuild the markers when the SET of placed stays changes, not
  // when a hover does.
  const signature = placed.map((i) => i.sourceId).join(',')

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return

    void (async () => {
      const L = await import('leaflet')
      if (cancelled || !containerRef.current) return

      const map = L.map(containerRef.current, {
        // The pills are the interface; a zoom control on top of them is one more thing to miss.
        zoomControl: false,
        scrollWheelZoom: false,
        attributionControl: true,
      })
      mapRef.current = map
      L.tileLayer(TILE_URL, {
        attribution: TILE_ATTRIBUTION,
        subdomains: TILE_SUBDOMAINS,
        maxZoom: 19,
      }).addTo(map)
      L.control.zoom({ position: 'bottomright' }).addTo(map)

      const points: [number, number][] = []
      for (const item of placed) {
        const at = item.hotel!.coordinates!
        const marker = L.marker([at.lat, at.lon], {
          icon: L.divIcon({
            className: 'map-pill-icon',
            html: pricePillHtml(item.priceMinor, item.currency, item.sourceId === chosenSourceId),
            // Let the pill size itself to its own text: a fixed `iconSize` would clip "€1,137"
            // or pad "€43" with empty box.
            iconSize: undefined,
          }),
          keyboard: false,
        }).addTo(map)
        marker.on('click', () => onPickRef.current(item.sourceId))
        markersRef.current.set(item.sourceId, marker)
        points.push([at.lat, at.lon])
      }

      if (centre) {
        L.marker([centre.lat, centre.lon], {
          icon: L.divIcon({ className: 'map-centre-icon', html: CENTRE_PIN_HTML }),
          interactive: false,
          keyboard: false,
        }).addTo(map)
        points.push([centre.lat, centre.lon])
      }

      if (points.length > 0) {
        // No animation, ever: `fitBounds` with `animate: false` is both the reduced-motion
        // answer and the right one for a map that appears already scrolled to where it belongs,
        // rather than flying there while she reads the list.
        map.fitBounds(L.latLngBounds(points).pad(0.15), { animate: false })
      } else {
        map.setView([0, 0], 2)
      }
    })()

    return () => {
      cancelled = true
      markersRef.current.clear()
      mapRef.current?.remove()
      mapRef.current = null
    }
    // `centre` and the pick callback are stable for a given results row; the pins are what this
    // rebuilds for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Hover and choice are a CLASS on an existing pin rather than a rebuild: forty markers torn
  // down and recreated on every mouse move is how a map starts dropping frames.
  useEffect(() => {
    for (const [sourceId, marker] of markersRef.current) {
      const pill = marker.getElement()?.querySelector('.map-pill')
      if (!pill) continue
      const active = sourceId === chosenSourceId || sourceId === highlightedSourceId
      pill.setAttribute('data-active', active ? 'true' : 'false')
    }
  }, [chosenSourceId, highlightedSourceId, signature])

  return (
    <div className="hotel-map" ref={containerRef} role="application" aria-label="Map of the stays" />
  )
}

export default HotelMap
