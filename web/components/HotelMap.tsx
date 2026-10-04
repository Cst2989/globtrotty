'use client'

import { useEffect, useRef } from 'react'
// Type-only, so nothing of MapLibre is evaluated during this module's own import — which Next
// does on the server even for a client component. The VALUE import is inside the effect.
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import { formatMoneyShort, money } from '@/src/money'
import type { ResultItemLite } from '@/web/data'
// Bundled from node_modules rather than fetched from a CDN, which is what keeps `style-src` at
// `'self'` and means a map renders with no third-party request but the style and its tiles.
import 'maplibre-gl/dist/maplibre-gl.css'

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
 * OpenFreeMap's `dark` style, and the attribution its data requires.
 *
 * Trip-stage pass, section 5. Three basemaps have now failed this page in turn and all three
 * failures were raster tile services: OSM's own servers answer an anonymous deployment with a
 * 403 and an "Access blocked" picture; CARTO's CDN answers every request with HTTP 200 and a
 * 2,513-byte tile reading "API KEY REQUIRED" — a broken map no status check can tell from a
 * working one; and Esri's Dark Gray Canvas, which did work, is a flat grey raster with its own
 * zoom ceiling and no way to ask it for English labels.
 *
 * OpenFreeMap serves VECTOR tiles, free, with no key and no registration, and a vector style is
 * what makes the rest of this section possible: the labels are data rather than pixels, so
 * `name:en` can be asked for (see `englishLabels`), and the whole map stays sharp at any zoom.
 * `dark` was checked before it was chosen — it answers 200 with a 21 KB style document — so the
 * fallback the brief allows for (`liberty` inside a bordered panel) is not needed.
 *
 * The origin is pinned in `web/csp.ts`, which also has to admit `blob:` for the workers MapLibre
 * starts and the images it decodes.
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'
export const MAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> '
  + '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'

/**
 * `&`, `<`, `>`, `"` and `'` as entities.
 *
 * A price pill is built as an HTML STRING — there is no React escaping on that path, which is
 * the one place in this project where a supplier-derived value would be interpolated into markup
 * raw. `priceMinor` is a decimal string by the time it reaches here (`web/data.ts` refuses
 * anything else) and `formatMoneyShort` only ever emits digits, separators and a currency
 * symbol, so this escape has nothing to do today. It is here because the NEXT person to put a
 * name or a label on a pill will reach for the same function, and because defence that only
 * exists once the hole does is not defence.
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
  const text = formatMoneyShort(money(BigInt(priceMinor), currency))
  return `<span class="map-pill" data-active="${active ? 'true' : 'false'}">${escapeHtml(text)}</span>`
}

/** The ring marking the city centre — the thing every distance on a card is measured from. */
const CENTRE_PIN_HTML = '<span class="map-centre" aria-hidden="true"></span>'

/**
 * Where MapLibre's tile worker is actually served from.
 *
 * Its own default builds the URL out of `import.meta.url`, which webpack rewrites to the PAGE's
 * URL — so the map asked for `/c/<conversation-id>/maplibre-gl-worker.mjs`, got a 404, and left
 * a blank canvas with one console line to explain it. `scripts/copy-maplibre.mjs` puts the
 * worker and the chunk it imports here before every dev and every build; `worker-src 'self'`
 * (web/csp.ts) is what admits it.
 */
export const MAP_WORKER_URL = '/maplibre/maplibre-gl-worker.mjs'

/**
 * Every label layer, asked for English where the style's data has it.
 *
 * SearchApi returns plenty of Tokyo in Japanese and so does OpenStreetMap, and a map whose
 * labels a traveller cannot read is a picture of a city rather than a map of one. OpenMapTiles
 * carries `name:en` for most places; `coalesce` falls back to the local name where it does not,
 * which is the honest answer — an empty label would be worse than a Japanese one.
 *
 * Pure, and exported so the test can pin the expression without a WebGL context.
 */
export const ENGLISH_TEXT_FIELD = [
  'coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name'],
] as const

function englishLabels(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== 'symbol') continue
    const field = (layer.layout as { 'text-field'?: unknown } | undefined)?.['text-field']
    if (field === undefined) continue
    try {
      map.setLayoutProperty(layer.id, 'text-field', ENGLISH_TEXT_FIELD as unknown as never)
    } catch {
      // A layer whose `text-field` this style builds some other way keeps its own. One label
      // left in the local language is not worth a thrown render.
    }
  }
}

/**
 * The Airbnb-style map beside the list: one price pill per stay, a ring on the city centre, and
 * the whole thing fitted to the pins it has.
 *
 * `'use client'` and loaded through `next/dynamic` with `ssr: false` by `ResultsPane`, because
 * MapLibre touches `window` at import time and would throw during a server render. MapLibre
 * itself is imported dynamically INSIDE the effect for the same reason — a top-level import runs
 * during the module's own evaluation, which Next does on the server even for a client component.
 *
 * The imperative shape (a ref, an effect, markers held outside React) is the map library's, not a
 * preference: it owns its own canvas, and re-rendering a map through React's reconciler would
 * mean tearing down and rebuilding every marker on every hover.
 */
export function HotelMap(
  { items, centre, chosenSourceId = null, highlightedSourceId = null, onPick }: HotelMapProps,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef<Map<string, Marker>>(new Map())
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  const placed = items.filter((i) => i.hotel?.coordinates)
  // What the effect below keys on: rebuild the markers when the SET of placed stays changes, not
  // when a hover does.
  const signature = placed.map((i) => i.sourceId).join(',')

  useEffect(() => {
    let cancelled = false
    if (!containerRef.current) return

    void (async () => {
      const maplibre = await import('maplibre-gl')
      if (cancelled || !containerRef.current) return
      maplibre.setWorkerUrl(MAP_WORKER_URL)

      const map = new maplibre.Map({
        container: containerRef.current,
        style: MAP_STYLE_URL,
        // The pills are the interface; a zoom control on top of them is one more thing to miss,
        // so the control goes bottom-right and the wheel is left alone (scrolling the pane past
        // a map should scroll the pane).
        attributionControl: { compact: true, customAttribution: MAP_ATTRIBUTION },
        scrollZoom: false,
        center: centre ? [centre.lon, centre.lat] : [0, 0],
        zoom: centre ? 10 : 1,
      })
      mapRef.current = map
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'bottom-right')

      const markers = markersRef.current
      const points: [number, number][] = []
      for (const item of placed) {
        const at = item.hotel!.coordinates!
        const element = document.createElement('div')
        element.className = 'map-pill-icon'
        element.innerHTML = pricePillHtml(item.priceMinor, item.currency, item.sourceId === chosenSourceId)
        element.addEventListener('click', () => onPickRef.current(item.sourceId))
        const marker = new maplibre.Marker({ element }).setLngLat([at.lon, at.lat]).addTo(map)
        markers.set(item.sourceId, marker)
        points.push([at.lon, at.lat])
      }

      if (centre) {
        const element = document.createElement('div')
        element.className = 'map-centre-icon'
        element.innerHTML = CENTRE_PIN_HTML
        new maplibre.Marker({ element }).setLngLat([centre.lon, centre.lat]).addTo(map)
        points.push([centre.lon, centre.lat])
      }

      if (points.length > 0) {
        const bounds = points.reduce(
          (acc, point) => acc.extend(point),
          new maplibre.LngLatBounds(points[0]!, points[0]!),
        )
        // No animation, ever: `animate: false` is both the reduced-motion answer and the right
        // one for a map that should appear already scrolled to where it belongs, rather than
        // flying there while she reads the list.
        map.fitBounds(bounds, { padding: 48, animate: false, maxZoom: 15 })
      }

      map.on('load', () => {
        if (!cancelled) englishLabels(map)
      })
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
      const pill = marker.getElement().querySelector('.map-pill')
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
