/**
 * Deliberately file-free: unlike `places.ts`/`airports.ts`/`countries.ts`, this module reads
 * nothing off disk, so `web/filters.ts` (bundled into the browser, through `FilterBar.tsx`) can
 * import `regionOfCountry`/`avoidRegionLabel`/`AvoidRegion` directly. The alias-matching a typed
 * "I don't want to stop in China" needs (`src/intake/connectionsAlias.ts`) is Node-only — it
 * reads `countries.json` for the country-name table — and lives in its own module for exactly
 * that reason: it is imported only by `src/agents/router.ts`, never by anything the browser
 * loads, and importing `./countries.js` from HERE would have pulled `node:fs` into that bundle.
 *
 * The ten buckets a "do not connect through X" filter can name (`Filter.avoidRegions`,
 * src/results.ts). Finer than `places.ts`'s own seven-way `Region` on purpose: `china`,
 * `russia` and `usa` are carved OUT of their continents because a traveller who says "not
 * through China" or "not through Russia" means that one country, not the whole of Asia or
 * Europe, and a single country is a poor fit for a region-sized checkbox either way (300
 * place-table entries share `asia`; `CN`/`HK`/`MO` do not need their own row beside it).
 *
 * `middle_east` is the one bucket that already matches `places.json`'s own convention: its
 * eleven members are exactly the countries that table already calls `middle_east` for its own
 * flight long-haul check (`isLongHaul`, `places.ts`). The rest — `europe`, `north_america`,
 * `asia`, `oceania`, `africa`, `south_america` — are that table's remaining six regions, with
 * `china`/`russia`/`usa`'s own members removed from whichever of them used to hold them.
 */
export type AvoidRegion =
  | 'china' | 'middle_east' | 'russia' | 'usa'
  | 'europe' | 'north_america' | 'asia' | 'oceania' | 'africa' | 'south_america'

/** Mainland China plus the two territories a traveller means by "China" in practice. */
const CHINA_COUNTRIES = new Set(['CN', 'HK', 'MO'])

/** The task brief's own eleven — identical to `places.json`'s `middle_east` region members. */
const MIDDLE_EAST_COUNTRIES = new Set(['AE', 'SA', 'QA', 'OM', 'KW', 'BH', 'IL', 'JO', 'LB', 'IR', 'IQ'])

/**
 * Every other ISO 3166-1 alpha-2 code this office's two airport/place tables can produce,
 * mapped onto the six remaining buckets. The 130 entries `places.json` itself names (minus
 * `CN`/`RU`/`US`, which are their own buckets above) keep that table's own region exactly —
 * see that table's `region` field, which this was built from. The rest is this table's own
 * addition: every other country `airports.json` carries (OurAirports' full `iso_country`
 * list), by ordinary continent, so a connection through an airport `places.json` never curated
 * still resolves to a bucket rather than falling through as unknown. Hand-maintained for the
 * same reason `countries.ts` is: a continent assignment is a judgement call (Cyprus, Georgia,
 * Russia's own Far East), and a silent drift between two runtime library versions does not
 * belong in a sentence this office prints about where she will or will not connect.
 */
const OTHER_COUNTRY_REGION: Record<string, Exclude<AvoidRegion, 'china' | 'middle_east' | 'russia' | 'usa'>> = {
  // From places.json, one entry per country, that table's own region.
  AM: 'asia', AO: 'africa', AR: 'south_america', AT: 'europe', AU: 'oceania', AW: 'north_america',
  AZ: 'asia', BA: 'europe', BB: 'north_america', BD: 'asia', BE: 'europe', BG: 'europe',
  BO: 'south_america', BR: 'south_america', BS: 'north_america', BW: 'africa', BY: 'europe',
  BZ: 'north_america', CA: 'north_america', CD: 'africa', CH: 'europe', CI: 'africa',
  CL: 'south_america', CO: 'south_america', CR: 'north_america', CU: 'north_america',
  CW: 'north_america', CZ: 'europe', DE: 'europe', DK: 'europe', DO: 'north_america',
  DZ: 'africa', EC: 'south_america', EE: 'europe', EG: 'africa', ES: 'europe', ET: 'africa',
  FI: 'europe', FJ: 'oceania', FR: 'europe', GB: 'europe', GE: 'asia', GH: 'africa', GR: 'europe',
  GT: 'north_america', HR: 'europe', HU: 'europe', ID: 'asia', IE: 'europe', IN: 'asia',
  IS: 'europe', IT: 'europe', JM: 'north_america', JP: 'asia', KE: 'africa', KH: 'asia',
  KR: 'asia', KZ: 'asia', LA: 'asia', LK: 'asia', LT: 'europe', LU: 'europe', LV: 'europe',
  LY: 'africa', MA: 'africa', MK: 'europe', MM: 'asia', MN: 'asia', MT: 'europe', MU: 'africa',
  MV: 'asia', MX: 'north_america', MY: 'asia', MZ: 'africa', NA: 'africa', NG: 'africa',
  NI: 'north_america', NL: 'europe', NO: 'europe', NP: 'asia', NZ: 'oceania', PA: 'north_america',
  PE: 'south_america', PG: 'oceania', PH: 'asia', PK: 'asia', PL: 'europe', PR: 'north_america',
  PT: 'europe', PY: 'south_america', RO: 'europe', RS: 'europe', RW: 'africa', SC: 'africa',
  SD: 'africa', SE: 'europe', SG: 'asia', SI: 'europe', SN: 'africa', SV: 'north_america',
  TH: 'asia', TN: 'africa', TR: 'europe', TT: 'north_america', TW: 'asia', TZ: 'africa',
  UA: 'europe', UG: 'africa', UY: 'south_america', UZ: 'asia', VE: 'south_america', VN: 'asia',
  ZA: 'africa', ZM: 'africa', ZW: 'africa',

  // Every other `airports.json` country `places.json` does not curate, by ordinary continent —
  // this office's own addition, not derived from either table.
  AF: 'asia', AG: 'north_america', AI: 'north_america', AL: 'europe', AS: 'oceania',
  BF: 'africa', BI: 'africa', BJ: 'africa', BL: 'north_america', BM: 'north_america',
  BN: 'asia', BQ: 'north_america', BT: 'asia', CC: 'oceania', CF: 'africa', CG: 'africa',
  CK: 'oceania', CM: 'africa', CV: 'africa', CX: 'oceania', CY: 'europe', DJ: 'africa',
  DM: 'north_america', EH: 'africa', ER: 'africa', FK: 'south_america', FM: 'oceania',
  FO: 'europe', GA: 'africa', GD: 'north_america', GF: 'south_america', GG: 'europe',
  GI: 'europe', GL: 'north_america', GM: 'africa', GN: 'africa', GP: 'north_america',
  GQ: 'africa', GU: 'oceania', GW: 'africa', GY: 'south_america', HN: 'north_america',
  HT: 'north_america', IM: 'europe', JE: 'europe', KG: 'asia', KI: 'oceania', KM: 'africa',
  KN: 'north_america', KP: 'asia', KY: 'north_america', LC: 'north_america', LR: 'africa',
  LS: 'africa', MD: 'europe', ME: 'europe', MF: 'north_america', MG: 'africa',
  MH: 'oceania', ML: 'africa', MP: 'oceania', MQ: 'north_america', MR: 'africa',
  MS: 'north_america', MW: 'africa', NC: 'oceania', NE: 'africa', NF: 'oceania',
  NR: 'oceania', NU: 'oceania', PF: 'oceania', PM: 'north_america', PW: 'oceania',
  RE: 'africa', SB: 'oceania', SH: 'africa', SK: 'europe', SL: 'africa', SO: 'africa',
  SR: 'south_america', SS: 'africa', ST: 'africa', SX: 'north_america', SY: 'asia',
  TC: 'north_america', TD: 'africa', TG: 'africa', TJ: 'asia', TM: 'asia', TO: 'oceania',
  TV: 'oceania', UM: 'oceania', VC: 'north_america', VG: 'north_america', VI: 'north_america',
  VU: 'oceania', WF: 'oceania', WS: 'oceania', XK: 'europe', YE: 'asia', YT: 'africa',
}

/**
 * The bucket an ISO 3166-1 alpha-2 country code falls into, or `null` for a code neither this
 * table nor `OTHER_COUNTRY_REGION` recognises. `applyFilter` (src/intake/filter.ts) and
 * `applyFilterLite` (web/filters.ts) both call this on a via airport's own country — never on a
 * code neither of them derived from `airports.json` in the first place.
 */
export function regionOfCountry(iso2: string): AvoidRegion | null {
  const code = iso2.trim().toUpperCase()
  if (CHINA_COUNTRIES.has(code)) return 'china'
  if (MIDDLE_EAST_COUNTRIES.has(code)) return 'middle_east'
  if (code === 'RU') return 'russia'
  if (code === 'US') return 'usa'
  return OTHER_COUNTRY_REGION[code] ?? null
}

/** The fixed English name for a bucket — what `describeFilter` and the filter bar's checklist print. */
export function avoidRegionLabel(region: AvoidRegion): string {
  switch (region) {
    case 'china': return 'China'
    case 'middle_east': return 'the Middle East'
    case 'russia': return 'Russia'
    case 'usa': return 'the United States'
    case 'europe': return 'Europe'
    case 'north_america': return 'North America'
    case 'asia': return 'Asia'
    case 'oceania': return 'Oceania'
    case 'africa': return 'Africa'
    case 'south_america': return 'South America'
  }
}

