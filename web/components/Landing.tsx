import { MessageBox } from './MessageBox'

const SUGGESTIONS = [
  'A week in Portugal in September for two',
  'Long weekend in Copenhagen from Berlin',
  'Ten days in Japan in spring',
]

/** Photo tiles behind the landing, all self-hosted (see public/landing/CREDITS.md). */
const TILES = [
  { src: '/landing/lisbon.webp', alt: '' },
  { src: '/landing/dolomites.webp', alt: '' },
  { src: '/landing/santorini.webp', alt: '' },
  { src: '/landing/kyoto.webp', alt: '' },
  { src: '/landing/beach.webp', alt: '' },
  { src: '/landing/copenhagen.webp', alt: '' },
  { src: '/landing/marrakech.webp', alt: '' },
  { src: '/landing/newyork.webp', alt: '' },
]

/**
 * The empty state for a new conversation: a wall of places under a dark
 * scrim, one line of headline, and the composer with its quick options
 * (when, who, budget) inside the box. Server component; `MessageBox` is the
 * client island. The photos are decorative (empty `alt`), served from this
 * origin so the CSP's `img-src 'self'` holds.
 */
export function Landing() {
  return (
    <div className="hero">
      <div className="hero-wall" aria-hidden="true">
        {TILES.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={t.src} src={t.src} alt={t.alt} loading="eager" decoding="async" />
        ))}
      </div>
      <div className="hero-inner">
        <h1>Where to next?</h1>
        <p>Say it in your own words. The desk searches live flights and hotels and comes back with a plan.</p>
        <MessageBox
          conversationId="new"
          variant="hero"
          quickOptions
          suggestions={SUGGESTIONS}
          placeholder="Somewhere warm in October, two of us, near the sea"
        />
      </div>
    </div>
  )
}
