export type ResultsSkeletonProps = {
  kind: 'flights' | 'hotels'
}

/** Five rows is enough to read as "a list is coming" without filling a tall screen with nothing. */
const CARD_COUNT = 5

/**
 * The results pane before there are any results: the summary bar as shimmering blocks, the sort
 * tabs greyed out, five card-shaped placeholders, and one line saying what is being searched for.
 *
 * It exists so the split appears the INSTANT she sends (results UI pass 2, E). Before this, the
 * page rendered the thread alone until the first `results` row landed, so the layout jumped from
 * one column to two somewhere between five and fifteen seconds in, and until then nothing on
 * screen said a search was running at all. Showing the shape the answer will arrive in is the
 * standard answer to that, and it costs nothing: no data, no request, no state.
 *
 * Every word here is fixed English chosen by this file — nothing she typed reaches it, which is
 * what makes it safe to render before any row exists to be masked.
 *
 * The shimmer is behind `prefers-reduced-motion: no-preference` in `app/globals.css`; with the
 * preference set, the same blocks render static.
 */
export function ResultsSkeleton({ kind }: ResultsSkeletonProps) {
  return (
    <section className="results-section results-skeleton" aria-label={kind === 'hotels' ? 'Searching hotels' : 'Searching flights'}>
      <div className="summary-bar" aria-hidden="true">
        <div className="summary-pills">
          <span className="skeleton-pill skeleton-pill-wide" />
          <span className="skeleton-pill" />
          <span className="skeleton-pill skeleton-pill-narrow" />
        </div>
      </div>

      <div className="results-layout">
        <div className="filter-rail" aria-hidden="true">
          <span className="skeleton-line skeleton-line-title" />
          <span className="skeleton-line" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-line-short" />
          <span className="skeleton-line skeleton-line-title" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-line-short" />
        </div>

        <div className="results-main">
          <div className="sort-tabs" aria-hidden="true">
            <span className="skeleton-tab" />
            <span className="skeleton-tab" />
            <span className="skeleton-tab" />
          </div>
          <p className="results-skeleton-note" role="status">
            {kind === 'hotels' ? 'Searching hotels…' : 'Searching flights…'}
          </p>
          <ul className="flight-list" aria-hidden="true">
            {Array.from({ length: CARD_COUNT }, (_, i) => (
              <li key={i} className="flight-card skeleton-card">
                <div className="flight-card-main">
                  <span className="skeleton-line skeleton-line-leg" />
                  <span className="skeleton-line skeleton-line-leg" />
                </div>
                <div className="flight-card-side">
                  <span className="skeleton-line skeleton-line-price" />
                  <span className="skeleton-line skeleton-line-short" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
