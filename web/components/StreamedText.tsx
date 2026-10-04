'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { revealSchedule, visibleSlice } from './stream'

export type StreamedTextProps = {
  /** The full message text — always rendered somewhere as a plain text child, never as markup. */
  text: string
  /**
   * `false` for a message that was already on the page at load (and for anything that is not an
   * agent reply): render `text` plainly and instantly, no cursor, no hidden duplicate — there is
   * nothing partial for a screen reader to need a full copy of.
   */
  animate: boolean
  /** Fired exactly once, the instant the reveal finishes (or immediately, when it never starts). */
  onDone?: () => void
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // No `matchMedia` at all: treat the preference as unset rather than refusing to reveal.
    return false
  }
}

/**
 * Streams `text` in word by word, about the pace Claude/ChatGPT's own replies type out at (the
 * ramp is `./stream.ts`'s `revealSchedule`), with a thin blinking cursor at the end while it
 * runs. Purely presentational and client-only: the DOM always carries the FULL text somewhere —
 * instantly when `animate` is false, and as a `.visually-hidden` duplicate alongside the partial,
 * `aria-hidden` visible span while a reveal is in flight — so a screen reader never gets less
 * than what is actually in the message.
 *
 * `prefers-reduced-motion: reduce` collapses the reveal to instant, same as `animate: false`.
 * That check only ever runs client-side (this component only animates once already mounted in
 * the browser — see `ThreadLive`'s own doc comment for why a freshly arrived message is never
 * part of a server-rendered pass), so reading `window` here carries no SSR risk.
 */
export function StreamedText({ text, animate, onDone }: StreamedTextProps) {
  const schedule = useMemo(() => revealSchedule(text), [text])
  const totalMs = schedule.length > 0 ? schedule[schedule.length - 1]!.at : 0
  const [reducedMotion] = useState(prefersReducedMotion)
  const instant = !animate || schedule.length === 0 || reducedMotion

  const [elapsed, setElapsed] = useState(0)
  const doneRef = useRef(false)
  const startRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  function fireDoneOnce() {
    if (doneRef.current) return
    doneRef.current = true
    onDoneRef.current?.()
  }

  useEffect(() => {
    if (instant) {
      fireDoneOnce()
      return
    }

    function tick(now: number) {
      if (startRef.current === null) startRef.current = now
      const e = Math.min(now - startRef.current, totalMs)
      setElapsed(e)
      if (e >= totalMs) {
        fireDoneOnce()
        return
      }
      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
    // `instant`/`totalMs` are the only things that should restart the loop; `fireDoneOnce` closes
    // over refs only and `onDone` itself is read through `onDoneRef` so an identity change on
    // every render (common for an inline arrow prop) never tears the animation down mid-reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instant, totalMs])

  if (instant) {
    return text
  }

  const visible = visibleSlice(text, elapsed, schedule)
  const isDone = elapsed >= totalMs

  return (
    <>
      <span aria-hidden="true">
        {visible}
        {isDone ? null : <span className="stream-cursor" />}
      </span>
      <span className="visually-hidden">{text}</span>
    </>
  )
}
