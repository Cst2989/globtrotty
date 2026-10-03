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

/** Words and bare numbers, in order, for the "within N tokens" adjacency checks below. */
function wordTokens(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(/[A-Za-z]+|\d+/g)) {
    const start = m.index ?? 0
    out.push({ text: m[0], start, end: start + m[0].length })
  }
  return out
}

/**
 * Words that typically introduce a place name ("fly *to* Nice", "visiting Split"). A token
 * preceded by one of these (within 2 tokens, skipping "the"/"a"/"an") is a cued mention --
 * see `isCued` below, added in fix round 1 after a review found exact/fuzzy place matches
 * firing on ordinary English words ("nice to visit" -> NCE, "split the bill" -> SPU).
 */
const CUES = new Set([
  'to', 'from', 'in', 'at', 'via', 'near', 'around', 'into', 'toward', 'towards',
  'fly', 'flying', 'visit', 'visiting', 'reach', 'leave', 'leaving', 'arrive', 'arriving',
])
const SKIP_WORDS = new Set(['the', 'a', 'an'])

/** Title Case ("Nice", "Split"), not ALL CAPS ("WAS") and not all-lower ("nice"). */
function isTitleCase(word: string): boolean {
  if (word.length < 2) return false
  const first = word[0]!
  return first === first.toUpperCase() && first !== first.toLowerCase() && word.slice(1) === word.slice(1).toLowerCase()
}

/** True when the nearest non-space character before `offset` is absent or a sentence-ending mark. */
function isSentenceStart(text: string, offset: number): boolean {
  let k = offset - 1
  while (k >= 0 && /\s/.test(text[k]!)) k--
  if (k < 0) return true
  const ch = text[k]!
  return ch === '.' || ch === '!' || ch === '?'
}

/**
 * A token at `tokens[i]` is "cued" -- i.e. a plausible place mention rather than an ordinary
 * word that happens to collide with a city/alias/code -- when either:
 *  - it is capitalised in the original text and not at the start of a sentence, or
 *  - one of the up-to-two preceding tokens (skipping "the"/"a"/"an", which don't count against
 *    that budget) is a word from CUES.
 */
function isCued(tokens: Token[], i: number, text: string): boolean {
  const tok = tokens[i]!
  if (isTitleCase(tok.text) && !isSentenceStart(text, tok.start)) return true
  let budget = 0
  for (let j = i - 1; j >= 0 && budget < 2; j--) {
    const prev = tokens[j]!.text.toLowerCase()
    if (SKIP_WORDS.has(prev)) continue
    budget++
    if (CUES.has(prev)) return true
  }
  return false
}

/**
 * Normalised alias/city keys that are also ordinary English words or names ("nice", "split",
 * "cologne", "male" the adjective, "la" as in "la la la"...). An exact match on one of these
 * only counts when `isCued` says the surrounding text actually looks like a place mention.
 * Judged by hand against the bundled table (see the brief's fix-round-1 ruling); codes that
 * read as proper nouns with no everyday meaning (Rome, Lima, Turin, Mumbai, the "nyc" alias)
 * are deliberately left off this list, since those are not realistically mistaken for prose.
 */
const AMBIGUOUS_PLACES = new Set([
  'nice', 'male', 'split', 'cologne', 'bath', 'reading', 'mobile', 'orange', 'nancy', 'la', 'sf',
  'bari', 'como', 'hull', 'derby', 'sale', 'phoenix', 'buffalo', 'mesa', 'provo', 'ogden', 'flint',
  'erie', 'troy', 'salem', 'dover', 'cork',
])

/**
 * Common English words that are also a Damerau-Levenshtein distance of 1 from some place name
 * (e.g. "parks" / "Paris"). Fuzzy matches on one of these are rejected even when cued, since
 * the word itself is far more likely to be ordinary prose than a one-letter-off place name.
 */
const ENGLISH_STOP = new Set([
  'parks', 'parts', 'party', 'place', 'plans', 'train', 'trail', 'visit', 'hotel', 'hotels',
  'night', 'nights', 'week', 'weeks', 'month', 'flight', 'flights', 'price', 'prices', 'cheap',
  'early', 'later', 'after', 'before', 'about', 'which', 'where', 'there', 'their', 'would',
  'could', 'should', 'first', 'three', 'seven', 'eight', 'round', 'trip', 'trips', 'hours',
  'stops', 'stop', 'beach', 'beaches', 'museum', 'dinner', 'lunch', 'class', 'adult', 'adults',
  'child', 'children',
])

/**
 * 3-letter codes that are also common English words (modal verbs, prepositions, pronouns,
 * month/weekday abbreviations...). An all-caps token matching one of these is accepted only
 * when cued, so a shouted "I WAS THERE" doesn't resolve to Washington but "fly to WAS" does.
 */
const AMBIGUOUS_CODES = new Set([
  'WAS', 'CAN', 'SAT', 'ADD', 'DEN', 'SEA', 'SUN', 'MAY', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR',
  'APR', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'AND', 'THE', 'FOR', 'NOT', 'BUT', 'ALL', 'ANY',
  'HAS', 'HAD', 'OUR', 'OUT', 'NEW', 'OLD', 'ONE', 'TWO', 'SIX', 'TEN', 'DAY', 'END', 'FAR',
  'FEW', 'GET', 'GOT', 'HER', 'HIM', 'HIS', 'HOW', 'LET', 'LOW', 'MAN', 'MEN', 'NOW', 'OFF',
  'OWN', 'PAY', 'PER', 'PUT', 'RUN', 'SAY', 'SET', 'SHE', 'SIT', 'TOO', 'TOP', 'TRY', 'USE',
  'WAY', 'WHO', 'WHY', 'YES', 'YET', 'YOU',
])

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

/**
 * Widest alias/city key in words (e.g. "san jose costa rica" is 4), so the exact-match sliding
 * window below covers every entry in the table rather than a value hand-picked for whatever
 * happened to be the longest key when this was first written.
 */
const MAX_WINDOW_SPAN: number = Math.max(1, ...[...ALIAS_MAP.keys()].map((k) => k.split(' ').length))

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
 *    cannot be mistaken for one (the brief's "simplest rule"). A code that doubles as an
 *    ordinary English word (`AMBIGUOUS_CODES`, e.g. `WAS`, `SAT`) additionally needs `isCued`.
 *  - city/alias names and local spellings match case-insensitively over sliding word windows
 *    (1 up to the longest alias/city key in the table, e.g. "san jose costa rica"), with
 *    a Damerau-Levenshtein <= 1 fallback for single words of 5+ letters (e.g. "tokio" -> Tokyo
 *    even if "tokio" were not already a listed alias). A key that doubles as an ordinary English
 *    word (`AMBIGUOUS_PLACES`, e.g. "nice", "split") needs `isCued` too; a fuzzy match is
 *    additionally rejected outright when the word itself is a common one (`ENGLISH_STOP`,
 *    e.g. "parks", which is one edit from "Paris").
 * Returns one candidate per code, in order of first appearance, with the span that matched.
 */
export function placeCandidates(text: string): PlaceCandidate[] {
  const tokens = letterTokens(text)
  const hits: { index: number; code: string; city: string; span: string }[] = []

  tokens.forEach((tok, i) => {
    if (tok.text !== tok.text.toUpperCase()) return
    const place = CODE_MAP.get(tok.text)
    if (!place) return
    if (AMBIGUOUS_CODES.has(tok.text) && !isCued(tokens, i, text)) return
    hits.push({ index: tok.start, code: place.code, city: place.city, span: tok.text })
  })

  for (let i = 0; i < tokens.length; i++) {
    for (let span = 1; span <= MAX_WINDOW_SPAN && i + span <= tokens.length; span++) {
      const first = tokens[i]!
      const last = tokens[i + span - 1]!
      const windowText = text.slice(first.start, last.end)
      const norm = normalise(windowText)
      const exact = ALIAS_MAP.get(norm)
      if (exact) {
        if (AMBIGUOUS_PLACES.has(norm) && !isCued(tokens, i, text)) continue
        hits.push({ index: first.start, code: exact.code, city: exact.city, span: windowText })
        continue
      }
      if (span === 1 && norm.length >= 5 && !ENGLISH_STOP.has(norm) && isCued(tokens, i, text)) {
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

const MONTH_FULL_NAMES: Record<string, string> = {}
for (const m of ['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']) {
  MONTH_FULL_NAMES[m] = m
}
// "may" is deliberately NOT a full name here even though it spells the whole month: its 3-letter
// form is indistinguishable from the modal verb ("it may rain"), so it always goes through the
// same adjacency gate as the other abbreviations below, never counting unconditionally.
const MONTH_ABBREVIATIONS: Record<string, string> = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june', jul: 'july',
  aug: 'august', sep: 'september', sept: 'september', oct: 'october', nov: 'november', dec: 'december',
}

const WEEKDAY_FULL_NAMES: Record<string, string> = {}
for (const w of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
  WEEKDAY_FULL_NAMES[w] = w
}
const WEEKDAY_ABBREVIATIONS: Record<string, string> = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
}

const RELATIVE_WORDS = new Set(['today', 'tomorrow', 'next', 'this'])

/** Tokens that are transparent for the "how many tokens apart" adjacency checks below: "20th of nov" is
 *  really "20" and "nov" with two bits of connective tissue in between, not three unrelated words. */
const DATE_FILLER = new Set(['of', 'st', 'nd', 'rd', 'th'])

/**
 * Candidate date fragments: ordinal and bare day numbers, months, 4-digit years (2024-2032),
 * weekday names and relative words. No calendar arithmetic here -- `src/intake/dates.ts` (a
 * later task) resolves these against "today".
 *
 * Full month/weekday names ("november", "sunday") always count. A 3-letter abbreviation --
 * including "may", see above -- only counts when it sits within one content-token of a bare day
 * number/ordinal (skipping DATE_FILLER, so "20th of nov" counts) or is immediately followed by
 * "."; a 3-letter weekday abbreviation only counts when a day number/ordinal follows within two
 * content-tokens. This stops "it may rain", "sun and warmth", "sat at the gate" and "got wed"
 * from reading as dates. A bare day number (no ordinal suffix) only counts when within two raw
 * tokens of a CONFIRMED month (full name, or an abbreviation that itself passed its own gate) or
 * the word "of"; an ordinal ("20th", "3rd") always counts on its own.
 */
export function datePartCandidates(text: string): DateParts {
  const lower = text.toLowerCase()
  const tokens = wordTokens(lower)

  // Map each non-filler token's raw sequence index to its position in the filler-free content
  // stream, so "adjacent" can mean "adjacent content word" rather than "adjacent raw token".
  const contentIndexBySeq = new Map<number, number>()
  tokens.forEach((tok, seq) => { if (!DATE_FILLER.has(tok.text)) contentIndexBySeq.set(seq, contentIndexBySeq.size) })
  const contentDistance = (seqA: number, seqB: number): number | undefined => {
    const a = contentIndexBySeq.get(seqA)
    const b = contentIndexBySeq.get(seqB)
    if (a === undefined || b === undefined) return undefined
    return b - a // positive when B follows A
  }

  const rawDaySeq = new Set<number>()
  tokens.forEach((tok, seq) => {
    if (/^\d{1,2}$/.test(tok.text)) {
      const n = Number(tok.text)
      if (n >= 1 && n <= 31) rawDaySeq.add(seq)
    }
  })
  const nearDayOrOrdinal = (seq: number, maxAbs: number, forwardOnly: boolean): boolean => {
    for (const daySeq of rawDaySeq) {
      const dist = contentDistance(seq, daySeq)
      if (dist === undefined || dist === 0) continue
      if (forwardOnly ? dist > 0 && dist <= maxAbs : Math.abs(dist) <= maxAbs) return true
    }
    return false
  }
  const followedByPeriod = (tok: Token) => lower[tok.end] === '.'

  const months: string[] = []
  const confirmedMonthSeq = new Set<number>()
  const weekdays: string[] = []
  const relative: string[] = []

  tokens.forEach((tok, seq) => {
    const full = MONTH_FULL_NAMES[tok.text]
    if (full) {
      confirmedMonthSeq.add(seq)
      if (!months.includes(full)) months.push(full)
      return
    }
    const abbrev = MONTH_ABBREVIATIONS[tok.text]
    if (abbrev && (nearDayOrOrdinal(seq, 1, false) || followedByPeriod(tok))) {
      confirmedMonthSeq.add(seq)
      if (!months.includes(abbrev)) months.push(abbrev)
    }
  })

  tokens.forEach((tok, seq) => {
    const full = WEEKDAY_FULL_NAMES[tok.text]
    if (full) { if (!weekdays.includes(full)) weekdays.push(full); return }
    const abbrev = WEEKDAY_ABBREVIATIONS[tok.text]
    if (abbrev && nearDayOrOrdinal(seq, 2, true)) { if (!weekdays.includes(abbrev)) weekdays.push(abbrev) }
  })

  tokens.forEach((tok) => {
    if (RELATIVE_WORDS.has(tok.text) && !relative.includes(tok.text)) relative.push(tok.text)
  })

  const days: number[] = []
  const addDay = (n: number) => { if (n >= 1 && n <= 31 && !days.includes(n)) days.push(n) }

  for (const m of lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)) addDay(Number(m[1]))

  const ofSeq = new Set<number>()
  tokens.forEach((tok, seq) => { if (tok.text === 'of') ofSeq.add(seq) })

  tokens.forEach((tok, seq) => {
    if (!/^\d{1,2}$/.test(tok.text)) return
    const n = Number(tok.text)
    if (n < 1 || n > 31) return
    const nearMonthOrOf = [seq - 2, seq - 1, seq + 1, seq + 2].some((s) => confirmedMonthSeq.has(s) || ofSeq.has(s))
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
