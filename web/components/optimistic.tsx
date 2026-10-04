'use client'

import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef,
  type ReactNode,
} from 'react'
import {
  PENDING_BACKSTOP_MS, settlePending,
  type PendingAction, type PendingActionKind, type PendingEntry, type PendingMessage,
  type ServerState,
} from './pending'

/**
 * Trip-stage pass, section 1: ONE optimistic store for the split, so the chat column and the
 * results pane move in the same tick.
 *
 * The author's rule is that every click changes the screen before any fetch. Pass 3 got there
 * with a flag per component, and the screenshot at 16.15 is what that cost: the pane had already
 * drawn the hotels skeleton and the chat was still a thread with nothing in it about a flight
 * having been chosen, because the two halves were keeping two separate answers to the same
 * question.
 *
 * So there is one answer, written synchronously by whoever was clicked, read by both halves, and
 * retired by the SERVER rather than by a timer or by the component that wrote it — `settlePending`
 * (`./pending.ts`) is the whole of the retirement policy, pure, and pinned by
 * `test/web-optimistic.test.ts` for every kind there is.
 *
 * With no provider above them — the landing page, every `renderToStaticMarkup` test — every
 * function here is a no-op and every reader sees an empty store, which is what keeps the pure
 * halves renderable on their own.
 */
export type Optimistic = {
  /** Still-unsettled messages, oldest first — the pending bubbles. */
  pendingMessages: PendingMessage[]
  /** The newest still-unsettled action, or `null`. */
  pendingAction: PendingAction | null
  /**
   * Record something the screen is claiming now. Call it SYNCHRONOUSLY in the click handler,
   * before any `await`; the returned id is what `resolve`/`fail`/`retry` name.
   */
  add: (entry: {
    kind: 'message' | PendingActionKind
    text: string
    sourceId?: string
    idempotencyKey?: string
    /**
     * What `retry` calls: the writer's own re-post, which is where the fetch belongs. Held
     * outside the reducer (a closure is not state) so re-registering it never re-renders.
     */
    onRetry?: () => void
  }) => string
  /** Drop one entry: its caller knows the server has it, or that it never will. */
  resolve: (id: string) => void
  /**
   * The POST came back unusable. A message keeps its bubble, marked for retry; an action is
   * dropped outright, which is what rolls the pane back.
   */
  fail: (id: string) => void
  /** Clear the failed mark on a message that is being re-posted. */
  retry: (id: string) => void
  /** True while anything at all is in flight — what the status line and the thinking row read. */
  busy: boolean
  /**
   * The pane is re-running a search she asked for with `Refresh prices`. Its own flag rather
   * than `busy`, because the status line has a more specific thing to say about it.
   */
  updating: boolean
  setUpdating: (value: boolean) => void
}

const NOOP: Optimistic = {
  pendingMessages: [],
  pendingAction: null,
  add: () => '',
  resolve: () => {},
  fail: () => {},
  retry: () => {},
  busy: false,
  updating: false,
  setUpdating: () => {},
}

const OptimisticContext = createContext<Optimistic>(NOOP)

type Action =
  | { type: 'add'; entry: PendingEntry }
  | { type: 'resolve'; ids: string[] }
  | { type: 'fail'; id: string }
  | { type: 'retry'; id: string; at: number }
  | { type: 'updating'; value: boolean }

type State = { entries: PendingEntry[]; updating: boolean }

const INITIAL: State = { entries: [], updating: false }

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'add':
      return { ...state, entries: [...state.entries, action.entry] }
    case 'resolve': {
      const drop = new Set(action.ids)
      const kept = state.entries.filter((e) => !drop.has(e.id))
      // Identity matters: this list is read during render, and a fresh array on every settle
      // check would re-render both islands forever.
      return kept.length === state.entries.length ? state : { ...state, entries: kept }
    }
    case 'fail': {
      const entries = state.entries.flatMap((e) => {
        if (e.id !== action.id) return [e]
        // An action that failed is simply untrue, so it goes; a message keeps its bubble, so she
        // has something to press.
        return e.kind === 'message' ? [{ ...e, failed: true }] : []
      })
      return { ...state, entries }
    }
    case 'retry':
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === action.id ? { ...e, failed: false, at: action.at } : e)),
      }
    case 'updating':
      return state.updating === action.value ? state : { ...state, updating: action.value }
  }
}

export type OptimisticProviderProps = {
  /** The server-rendered truth this render is reasoning about — see `serverStateFor`. */
  server: ServerState
  children: ReactNode
}

/**
 * Mounted by the conversation page around BOTH islands.
 *
 * Settling happens during render, so the chat and the pane never disagree for a frame; the
 * reducer is then pruned by one effect that fires only when the settled set actually changes,
 * plus a per-entry `PENDING_BACKSTOP_MS` timer, because time passing is not a render.
 */
export function OptimisticProvider({ server, children }: OptimisticProviderProps) {
  const [state, dispatch] = useReducer(reduce, INITIAL)
  // Read by `add`, which runs in a click handler and must see the CURRENT snapshot rather than
  // whichever one its closure was built with.
  const serverRef = useRef(server)
  serverRef.current = server
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const retriesRef = useRef<Map<string, () => void>>(new Map())

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(id)
  }, [])

  const add = useCallback((entry: {
    kind: 'message' | PendingActionKind
    text: string
    sourceId?: string
    idempotencyKey?: string
    onRetry?: () => void
  }): string => {
    const id = crypto.randomUUID()
    if (entry.onRetry) retriesRef.current.set(id, entry.onRetry)
    let seenCount = 0
    for (const content of serverRef.current.userMessages) if (content === entry.text) seenCount++
    dispatch({
      type: 'add',
      entry: {
        id,
        at: Date.now(),
        kind: entry.kind,
        text: entry.text,
        sourceId: entry.sourceId,
        idempotencyKey: entry.idempotencyKey,
        seenCount,
        failed: false,
      },
    })
    const timer = setTimeout(() => {
      timersRef.current.delete(id)
      retriesRef.current.delete(id)
      dispatch({ type: 'resolve', ids: [id] })
    }, PENDING_BACKSTOP_MS)
    timersRef.current.set(id, timer)
    return id
  }, [])

  const resolve = useCallback((id: string) => {
    clearTimer(id)
    retriesRef.current.delete(id)
    dispatch({ type: 'resolve', ids: [id] })
  }, [clearTimer])

  const fail = useCallback((id: string) => {
    dispatch({ type: 'fail', id })
  }, [])

  const retry = useCallback((id: string) => {
    dispatch({ type: 'retry', id, at: Date.now() })
    retriesRef.current.get(id)?.()
  }, [])

  const setUpdating = useCallback((value: boolean) => {
    dispatch({ type: 'updating', value })
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // The settle pass, during render. `now` is read once rather than per entry, so two entries
  // added in the same tick are judged against the same instant.
  const now = Date.now()
  const live: PendingEntry[] = []
  const settled: string[] = []
  for (const entry of state.entries) {
    // A message she has been offered a retry for is hers to clear, not the server's.
    if (entry.failed || !settlePending(server, entry, now)) live.push(entry)
    else settled.push(entry.id)
  }

  const settledKey = settled.join(',')
  useEffect(() => {
    if (settledKey === '') return
    const ids = settledKey.split(',')
    for (const id of ids) {
      clearTimer(id)
      retriesRef.current.delete(id)
    }
    dispatch({ type: 'resolve', ids })
    // `settledKey` is the whole of what this depends on; `settled` is a fresh array per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey])

  const messagesKey = live.filter((e) => e.kind === 'message').map((e) => `${e.id}:${e.failed}`).join('|')
  const pendingMessages = useMemo<PendingMessage[]>(
    () => live
      .filter((e) => e.kind === 'message')
      .map((e) => ({
        id: e.id,
        content: e.text,
        at: e.at,
        idempotencyKey: e.idempotencyKey ?? '',
        failed: e.failed,
      })),
    // `live` is rebuilt every render by design; `messagesKey` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messagesKey],
  )

  const newestAction = [...live].reverse().find((e) => e.kind !== 'message')
  const actionKind = newestAction?.kind as PendingActionKind | undefined
  const actionAt = newestAction?.at
  const actionSourceId = newestAction?.sourceId
  const actionLabel = newestAction?.text
  const pendingAction = useMemo<PendingAction | null>(
    () => (actionKind === undefined || actionAt === undefined
      ? null
      : { kind: actionKind, label: actionLabel ?? '', at: actionAt, sourceId: actionSourceId }),
    [actionKind, actionAt, actionSourceId, actionLabel],
  )

  const busy = live.some((e) => !e.failed)

  const value = useMemo<Optimistic>(
    () => ({
      pendingMessages,
      pendingAction,
      add,
      resolve,
      fail,
      retry,
      busy,
      updating: state.updating,
      setUpdating,
    }),
    [pendingMessages, pendingAction, busy, state.updating, add, resolve, fail, retry, setUpdating],
  )

  // Scenario (f)'s instrument: how many times this provider has rendered, readable from the
  // browser harness. Development only, and nothing in the app itself ever reads it.
  if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
    const w = window as unknown as { __gtOptimisticRenders?: number }
    w.__gtOptimisticRenders = (w.__gtOptimisticRenders ?? 0) + 1
  }

  return <OptimisticContext.Provider value={value}>{children}</OptimisticContext.Provider>
}

export function useOptimistic(): Optimistic {
  return useContext(OptimisticContext)
}
