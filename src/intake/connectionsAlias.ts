import { COUNTRIES } from './countries.js'
import { regionOfCountry, type AvoidRegion } from './regions.js'

/**
 * Node-only (reads `countries.json` through `./countries.js`'s own file-read-at-import), and
 * imported only by `src/agents/router.ts` — never by `web/filters.ts` or any client component,
 * which is why this alias-matching logic lives in its own module rather than inside
 * `src/intake/regions.ts` itself: that module is deliberately file-free so the browser bundle
 * can import its region lookup directly.
 */

/** One phrase in an alias table below, matched as a whole word/phrase, case-insensitively. */
type Alias = { pattern: string; value: string }

/**
 * The fixed region vocabulary a typed "I don't want to stop in China or the Middle East" is
 * matched against — the brief's own list verbatim (`china`, `chinese`, `middle east`, `gulf`,
 * `russia`, `usa`, `united states`, `america`, `europe`, `asia`, `africa`), plus one alias each
 * for the three buckets that list leaves unreachable by typed message (`south_america`,
 * `north_america`, `oceania` — real `AvoidRegion` values with nothing in the brief's own table
 * to set them, which would otherwise make them write-only from the filter bar alone).
 */
const REGION_ALIASES: Alias[] = [
  { pattern: 'china', value: 'china' },
  { pattern: 'chinese', value: 'china' },
  { pattern: 'middle east', value: 'middle_east' },
  { pattern: 'gulf', value: 'middle_east' },
  { pattern: 'russia', value: 'russia' },
  { pattern: 'usa', value: 'usa' },
  { pattern: 'united states', value: 'usa' },
  { pattern: 'america', value: 'usa' },
  { pattern: 'europe', value: 'europe' },
  { pattern: 'asia', value: 'asia' },
  { pattern: 'africa', value: 'africa' },
  { pattern: 'south america', value: 'south_america' },
  { pattern: 'north america', value: 'north_america' },
  { pattern: 'oceania', value: 'oceania' },
]

/**
 * The top 40 countries' demonyms, for a typed "I don't want to connect through Japan" vs
 * "...through Japanese cities" to resolve the same way. Deliberately a small hand-picked set
 * (not all 130 of `COUNTRIES`'s entries have one obvious single-word form, and a wrong guess —
 * "Congolese" for which of two Congos — is worse than no guess) rather than a generated list;
 * the plain country NAME alias below already covers every country this office's tables name,
 * demonym or not.
 */
const DEMONYM_ALIASES: Record<string, string> = {
  japanese: 'JP', korean: 'KR', indian: 'IN', thai: 'TH', vietnamese: 'VN', indonesian: 'ID',
  filipino: 'PH', malaysian: 'MY', singaporean: 'SG', turkish: 'TR', egyptian: 'EG',
  'south african': 'ZA', nigerian: 'NG', kenyan: 'KE', moroccan: 'MA', brazilian: 'BR',
  argentine: 'AR', mexican: 'MX', canadian: 'CA', british: 'GB', french: 'FR', german: 'DE',
  italian: 'IT', spanish: 'ES', portuguese: 'PT', dutch: 'NL', polish: 'PL', greek: 'GR',
  swedish: 'SE', norwegian: 'NO', finnish: 'FI', danish: 'DK', irish: 'IE', swiss: 'CH',
  austrian: 'AT', australian: 'AU', 'new zealand': 'NZ', chilean: 'CL', colombian: 'CO',
  peruvian: 'PE', venezuelan: 'VE', cuban: 'CU',
}

/** Every `COUNTRIES` entry's own name, lower-cased, as an alias onto its code. */
const COUNTRY_NAME_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRIES).map(([code, name]) => [name.toLowerCase(), code]),
)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `phrase`, matched as a whole word/phrase against `text` — internal spaces may stretch. */
function phraseIndex(text: string, phrase: string): number {
  const re = new RegExp(`\\b${escapeRegExp(phrase).replace(/ /g, '\\s+')}\\b`, 'i')
  const m = re.exec(text)
  return m ? m.index : -1
}

/**
 * The regions and countries a typed "I don't want to stop in China or the Middle East" names,
 * read off the fixed alias tables above — never off the free text itself, so nothing she types
 * reaches the model or a `results` row except one of these ten region keys or a two-letter ISO
 * code already in `COUNTRIES`.
 *
 * Both lists are in the order their alias first appears in `text`, deduplicated, and a country
 * already covered by a matched REGION is dropped from the country list — "China" should not
 * also write `avoidCountries: ['CN']` alongside `avoidRegions: ['china']`, since the region
 * already excludes it and `describeFilter` would otherwise say the same thing twice. A country
 * she named on its own (not inside a matched region's own words) is kept, so "Japan and the
 * Middle East" still narrows to one specific country plus one whole region.
 */
export function resolveConnectionsAvoidance(text: string): { countries: string[]; regions: AvoidRegion[] } {
  const regionHits: { value: AvoidRegion; index: number }[] = []
  for (const alias of REGION_ALIASES) {
    const index = phraseIndex(text, alias.pattern)
    if (index >= 0) regionHits.push({ value: alias.value as AvoidRegion, index })
  }
  regionHits.sort((a, b) => a.index - b.index)
  const regions: AvoidRegion[] = []
  for (const hit of regionHits) if (!regions.includes(hit.value)) regions.push(hit.value)

  const countryHits: { value: string; index: number }[] = []
  const countryAliases: Alias[] = [
    ...Object.entries(COUNTRY_NAME_ALIASES).map(([pattern, value]) => ({ pattern, value })),
    ...Object.entries(DEMONYM_ALIASES).map(([pattern, value]) => ({ pattern, value })),
  ]
  for (const alias of countryAliases) {
    const index = phraseIndex(text, alias.pattern)
    if (index >= 0) countryHits.push({ value: alias.value, index })
  }
  countryHits.sort((a, b) => a.index - b.index)
  const countries: string[] = []
  for (const hit of countryHits) {
    if (countries.includes(hit.value)) continue
    const region = regionOfCountry(hit.value)
    if (region !== null && regions.includes(region)) continue
    countries.push(hit.value)
  }

  return { countries, regions }
}
