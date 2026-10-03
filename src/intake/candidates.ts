import { ALIAS_MAP, CODE_MAP, normalise } from './places.js'

export type PlaceCandidate = { code: string; city: string; span: string }
export type DateParts = { days: number[]; months: string[]; years: number[]; weekdays: string[]; relative: string[] }

type Token = { text: string; start: number; end: number }

/** Sequences of letters (incl. common Latin accents), as windows for place matching. */
function letterTokens(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g)) {
    const start = m.index ?? 0
    out.push({ text: m[0], start, end: start + m[0].length })
  }
  return out
}

/** Words and bare numbers, in order, for the "within two tokens" adjacency check in datePartCandidates. */
function wordTokens(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(/[A-Za-z]+|\d+/g)) {
    const start = m.index ?? 0
    out.push({ text: m[0], start, end: start + m[0].length })
  }
  return out
}

/** Damerau-Levenshtein edit distance; >1 only matters as "not <= 1", so lengths 2+ apart short-circuit. */
function damerauLevenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2
  const al = a.length
  const bl = b.length
  const d: number[][] = []
  for (let i = 0; i <= al; i++) {
    const row: number[] = []
    for (let j = 0; j <= bl; j++) row.push(i === 0 ? j : j === 0 ? i : 0)
    d.push(row)
  }
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const rowI = d[i]!
      const rowPrev = d[i - 1]!
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rowI[j] = Math.min(rowPrev[j]! + 1, rowI[j - 1]! + 1, rowPrev[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rowI[j] = Math.min(rowI[j]!, d[i - 2]![j - 2]! + 1)
      }
    }
  }
  return d[al]![bl]!
}

/** Single-word alias/city keys, cached once: fuzzy matching only ever compares against these. */
const SINGLE_WORD_KEYS: string[] = [...ALIAS_MAP.keys()].filter((k) => !k.includes(' '))

/** Damerau-Levenshtein <= 1, only for words of 5+ letters (never for the short 3-letter codes). */
function fuzzyPlace(word: string) {
  if (word.length < 5) return undefined
  for (const key of SINGLE_WORD_KEYS) {
    if (Math.abs(key.length - word.length) > 1) continue
    if (damerauLevenshtein(word, key) <= 1) return ALIAS_MAP.get(key)
  }
  return undefined
}

/**
 * Finds place mentions by span. Two independent mechanisms, by design:
 *  - a 3-letter all-caps token (`BCN`, `NYC`) is a code match only when written upper-case in
 *    the original text -- lower/mixed case never matches a code, so "the" or a stray "la"
 *    cannot be mistaken for one (the brief's "simplest rule").
 *  - city/alias names and local spellings match case-insensitively over 1-3 word windows, with
 *    a Damerau-Levenshtein <= 1 fallback for single words of 5+ letters (e.g. "tokio" -> Tokyo
 *    even if "tokio" were not already a listed alias).
 * Returns one candidate per code, in order of first appearance, with the span that matched.
 */
export function placeCandidates(text: string): PlaceCandidate[] {
  const tokens = letterTokens(text)
  const hits: { index: number; code: string; city: string; span: string }[] = []

  for (const tok of tokens) {
    if (tok.text === tok.text.toUpperCase()) {
      const place = CODE_MAP.get(tok.text)
      if (place) hits.push({ index: tok.start, code: place.code, city: place.city, span: tok.text })
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    for (let span = 1; span <= 3 && i + span <= tokens.length; span++) {
      const first = tokens[i]!
      const last = tokens[i + span - 1]!
      const windowText = text.slice(first.start, last.end)
      const norm = normalise(windowText)
      const exact = ALIAS_MAP.get(norm)
      if (exact) { hits.push({ index: first.start, code: exact.code, city: exact.city, span: windowText }); continue }
      if (span === 1 && norm.length >= 5) {
        const fuzzy = fuzzyPlace(norm)
        if (fuzzy) hits.push({ index: first.start, code: fuzzy.code, city: fuzzy.city, span: windowText })
      }
    }
  }

  hits.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: PlaceCandidate[] = []
  for (const h of hits) {
    if (seen.has(h.code)) continue
    seen.add(h.code)
    out.push({ code: h.code, city: h.city, span: h.span })
  }
  return out
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_BY_WORD: Record<string, string> = {}
for (const m of MONTHS) {
  MONTH_BY_WORD[m] = m
  MONTH_BY_WORD[m.slice(0, 3)] = m
}
MONTH_BY_WORD.sept = 'september'

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const WEEKDAY_BY_WORD: Record<string, string> = {}
for (const w of WEEKDAYS) {
  WEEKDAY_BY_WORD[w] = w
  WEEKDAY_BY_WORD[w.slice(0, 3)] = w
}

const RELATIVE_WORDS = new Set(['today', 'tomorrow', 'next', 'this'])

/**
 * Candidate date fragments: ordinal and bare day numbers, months, 4-digit years (2024-2032),
 * weekday names and relative words. No calendar arithmetic here -- `src/intake/dates.ts` (a
 * later task) resolves these against "today". A bare day number (no ordinal suffix) only
 * counts when within two tokens of a month name or the word "of"; an ordinal ("20th", "3rd")
 * always counts, since the suffix alone is a strong enough signal.
 */
export function datePartCandidates(text: string): DateParts {
  const lower = text.toLowerCase()
  const tokens = wordTokens(lower)

  const monthSeq = new Set<number>()
  const ofSeq = new Set<number>()
  const months: string[] = []
  const weekdays: string[] = []
  const relative: string[] = []

  tokens.forEach((tok, seq) => {
    const monthName = MONTH_BY_WORD[tok.text]
    if (monthName) { monthSeq.add(seq); if (!months.includes(monthName)) months.push(monthName) }
    if (tok.text === 'of') ofSeq.add(seq)
    const weekdayName = WEEKDAY_BY_WORD[tok.text]
    if (weekdayName && !weekdays.includes(weekdayName)) weekdays.push(weekdayName)
    if (RELATIVE_WORDS.has(tok.text) && !relative.includes(tok.text)) relative.push(tok.text)
  })

  const days: number[] = []
  const addDay = (n: number) => { if (n >= 1 && n <= 31 && !days.includes(n)) days.push(n) }

  for (const m of lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)) addDay(Number(m[1]))

  tokens.forEach((tok, seq) => {
    if (!/^\d{1,2}$/.test(tok.text)) return
    const n = Number(tok.text)
    if (n < 1 || n > 31) return
    const nearMonthOrOf = [seq - 2, seq - 1, seq + 1, seq + 2].some((s) => monthSeq.has(s) || ofSeq.has(s))
    if (nearMonthOrOf) addDay(n)
  })

  const years: number[] = []
  for (const m of lower.matchAll(/\b\d{4}\b/g)) {
    const n = Number(m[0])
    if (n >= 2024 && n <= 2032 && !years.includes(n)) years.push(n)
  }

  return { days, months, years, weekdays, relative }
}

const PARTNER_PHRASES = ['my wife', 'my husband', 'my partner', 'the two of us', 'both of us', 'couple']
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }

/** Small integers (1-9), number words (one..nine) and partner phrases ("my wife" -> 2, etc.). */
export function countCandidates(text: string): number[] {
  const lower = text.toLowerCase()
  const found: number[] = []
  const add = (n: number) => { if (!found.includes(n)) found.push(n) }

  for (const m of lower.matchAll(/\b[1-9]\b/g)) add(Number(m[0]))
  for (const m of lower.matchAll(/[a-z]+/g)) {
    const n = NUMBER_WORDS[m[0]]
    if (n) add(n)
  }
  for (const phrase of PARTNER_PHRASES) if (lower.includes(phrase)) add(2)

  return found
}
