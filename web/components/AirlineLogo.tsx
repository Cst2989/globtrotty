'use client'

import { useState } from 'react'

export type AirlineLogoProps = {
  /** The carrier's IATA code — what Kiwi's logo CDN keys on, and the fallback label. */
  code: string
  /** The airline's own name (`airlineName`, resolved in `web/data.ts`), used as the `alt` text. */
  name: string
  size?: number
}

/**
 * One carrier's logo, from Kiwi's public logo CDN, with the code in a styled circle whenever the
 * image does not arrive.
 *
 * A client island purely for the `onError` fallback: there are ~1000 carriers and the CDN has no
 * logo for all of them, so a card that trusted the image would show a broken-image glyph beside a
 * €2,657 price. `useState` with no router and no effect, so `renderToStaticMarkup` still renders
 * it (the server pass always produces the `<img>` — the fallback is a browser-only event).
 *
 * `alt` is the airline NAME, never the code: the code is already on the card for anyone reading
 * it, and "QR" read aloud by a screen reader is not an airline.
 *
 * `https://images.kiwi.com` is named exactly in `web/csp.ts`'s `img-src`; see that file for why
 * one third-party image origin was the right trade against self-hosting the whole set.
 */
export function AirlineLogo({ code, name, size = 28 }: AirlineLogoProps) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className="airline-badge" style={{ width: size, height: size }} title={name}>
        {code}
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="airline-logo"
      src={`https://images.kiwi.com/airlines/64/${code}.png`}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
