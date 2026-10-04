/**
 * `withViewTransition(fn)` — run `fn` inside a View Transition when the browser has one and the
 * viewer has not asked for less motion, and plainly otherwise.
 *
 * The one place it earns its keep is the landing's send (`MessageBox`): her message POSTs, the
 * route creates the conversation, and `router.push` replaces a full-bleed photo wall with the
 * split view. Without a transition that is a hard cut on the slowest frame of the whole flow —
 * exactly when she is least sure anything happened. With one, the thread, the results pane and
 * the rail cross-fade into place (`view-transition-name` on each, `app/globals.css`).
 *
 * Both guards matter and neither is optional: `startViewTransition` is still absent in some
 * engines, and a cross-fade is motion, which `prefers-reduced-motion: reduce` is a request not to
 * show. The CSS also disables the animations under that query — belt and braces, because a
 * transition started here with no animation attached still takes a frame.
 *
 * Never throws: a browser that rejects the transition (another one already running, a
 * same-document navigation it cannot capture) still gets `fn` run, because `fn` is the actual
 * navigation and losing it would leave her on the landing page with her message sent.
 */
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // No `matchMedia` at all (a very old engine, a non-browser runtime): treat the preference as
    // unset rather than refusing to navigate.
    return false
  }
}

export function withViewTransition(fn: () => void): void {
  const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument)
  if (!doc || typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    fn()
    return
  }
  try {
    doc.startViewTransition(() => fn())
  } catch {
    fn()
  }
}
