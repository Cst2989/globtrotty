#!/usr/bin/env node
// Builds src/intake/places.json from OurAirports' airports.csv.
//
// Why this isn't a pure "group large_airport rows by municipality" script:
// OurAirports' `large_airport` type is a physical-infrastructure
// classification (runway length etc.), not a passenger-traffic ranking, and
// the CSV carries no traffic/population column. Grouping every
// `large_airport` row by municipality yields over 1,100 metro areas
// worldwide today -- far more than "the 300 busiest metro areas" this table
// targets, and there is no field in this dataset to rank them down to 300.
// So which ~290 cities count as "busiest" is a judgment call made here (the
// same kind of call the brief's own fallback path -- "hand-write the
// busiest metros from memory" -- asks for), and each city's IATA/metro code
// was looked up by hand against this exact CSV. What the script still gets
// from the live download, every run, is independent of memory: each code's
// continent (-> region) and a sanity check that the code is a real airport
// in the current dataset, so a stale or mistyped code is caught rather than
// silently shipped.
//
// Each entry also carries `center`: the city's own coordinates, geocoded once
// through Nominatim and cached in scripts/.cache/geocode.json (committed, so a
// rebuild is offline and nobody re-hammers a free service for an answer this
// repo already has). The hotels pass needs it for "3.2 km from centre" on a
// hotel card, which is a haversine from this point.
//
// Usage: node scripts/build-places.mjs
// Writes: src/intake/places.json, scripts/.cache/geocode.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv'
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', 'src', 'intake', 'places.json')
const CACHE_DIR = path.join(__dirname, '.cache')
const GEOCODE_CACHE_PATH = path.join(CACHE_DIR, 'geocode.json')

/** Minimal CSV line parser respecting double-quoted fields (handles embedded commas/quotes). */
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

// Continent -> region. Middle-east countries override continent (OurAirports
// files them under AS, except Istanbul/Moscow which it files under EU).
const CONTINENT_REGION = {
  EU: 'europe', NA: 'north_america', AS: 'asia', OC: 'oceania', AF: 'africa', SA: 'south_america',
}
const MIDDLE_EAST_COUNTRIES = new Set(['AE', 'SA', 'QA', 'OM', 'KW', 'BH', 'IL', 'JO', 'LB', 'IR', 'IQ'])

function regionFor(continent, country) {
  if (MIDDLE_EAST_COUNTRIES.has(country)) return 'middle_east'
  return CONTINENT_REGION[continent] ?? null
}

// Metro codes for cities served by more than one large airport (IATA defines
// a metro code covering all of them; a traveller searching for the city
// should get one entry, not one per terminal airport). The explicit list
// from the brief, plus the code each covers for the region/validation check.
const METRO_PLACES = [
  { code: 'TYO', city: 'Tokyo', country: 'JP', region: 'asia', sampleAirport: 'HND' },
  { code: 'LON', city: 'London', country: 'GB', region: 'europe', sampleAirport: 'LHR' },
  { code: 'PAR', city: 'Paris', country: 'FR', region: 'europe', sampleAirport: 'CDG' },
  { code: 'NYC', city: 'New York', country: 'US', region: 'north_america', sampleAirport: 'JFK' },
  { code: 'MIL', city: 'Milan', country: 'IT', region: 'europe', sampleAirport: 'MXP' },
  { code: 'ROM', city: 'Rome', country: 'IT', region: 'europe', sampleAirport: 'FCO' },
  { code: 'OSA', city: 'Osaka', country: 'JP', region: 'asia', sampleAirport: 'KIX' },
  { code: 'BUE', city: 'Buenos Aires', country: 'AR', region: 'south_america', sampleAirport: 'EZE' },
  { code: 'SAO', city: 'Sao Paulo', country: 'BR', region: 'south_america', sampleAirport: 'GRU' },
  { code: 'RIO', city: 'Rio de Janeiro', country: 'BR', region: 'south_america', sampleAirport: 'GIG' },
  { code: 'CHI', city: 'Chicago', country: 'US', region: 'north_america', sampleAirport: 'ORD' },
  { code: 'WAS', city: 'Washington', country: 'US', region: 'north_america', sampleAirport: 'IAD' },
  { code: 'MOW', city: 'Moscow', country: 'RU', region: 'europe', sampleAirport: 'SVO' },
  // transcontinental; travel convention: Istanbul straddles Europe/Asia at the Bosphorus, but
  // flight-search and travel-industry convention files it under Europe (same convention this
  // script applies to Moscow above), so region is 'europe' rather than split by airport.
  { code: 'IST', city: 'Istanbul', country: 'TR', region: 'europe', sampleAirport: 'IST' },
  { code: 'BJS', city: 'Beijing', country: 'CN', region: 'asia', sampleAirport: 'PEK' },
  { code: 'SHA', city: 'Shanghai', country: 'CN', region: 'asia', sampleAirport: 'PVG' },
  { code: 'SEL', city: 'Seoul', country: 'KR', region: 'asia', sampleAirport: 'ICN' },
  { code: 'BKK', city: 'Bangkok', country: 'TH', region: 'asia', sampleAirport: 'BKK' },
  { code: 'JKT', city: 'Jakarta', country: 'ID', region: 'asia', sampleAirport: 'CGK' },
  { code: 'TPE', city: 'Taipei', country: 'TW', region: 'asia', sampleAirport: 'TPE' },
  { code: 'STO', city: 'Stockholm', country: 'SE', region: 'europe', sampleAirport: 'ARN' },
]

// Curated list of major metro areas (single-airport, or an airport chosen as
// the primary one for a multi-airport city not in METRO_PLACES above) with
// their IATA code, country (ISO alpha-2) and region, looked up by hand
// against OurAirports. `city` overrides the display name where it should
// differ from the common English name.
const CURATED_PLACES = [
  // North America
  { code: 'LAX', city: 'Los Angeles', country: 'US' }, { code: 'SFO', city: 'San Francisco', country: 'US' },
  { code: 'MIA', city: 'Miami', country: 'US' }, { code: 'DFW', city: 'Dallas', country: 'US' },
  { code: 'IAH', city: 'Houston', country: 'US' }, { code: 'BOS', city: 'Boston', country: 'US' },
  { code: 'ATL', city: 'Atlanta', country: 'US' }, { code: 'DEN', city: 'Denver', country: 'US' },
  { code: 'SEA', city: 'Seattle', country: 'US' }, { code: 'LAS', city: 'Las Vegas', country: 'US' },
  { code: 'MCO', city: 'Orlando', country: 'US' }, { code: 'PHX', city: 'Phoenix', country: 'US' },
  { code: 'SAN', city: 'San Diego', country: 'US' }, { code: 'PHL', city: 'Philadelphia', country: 'US' },
  { code: 'MSP', city: 'Minneapolis', country: 'US' }, { code: 'DTW', city: 'Detroit', country: 'US' },
  { code: 'CLT', city: 'Charlotte', country: 'US' }, { code: 'BNA', city: 'Nashville', country: 'US' },
  { code: 'AUS', city: 'Austin', country: 'US' }, { code: 'SJC', city: 'San Jose', country: 'US' },
  { code: 'PDX', city: 'Portland', country: 'US' }, { code: 'SLC', city: 'Salt Lake City', country: 'US' },
  { code: 'HNL', city: 'Honolulu', country: 'US' }, { code: 'MSY', city: 'New Orleans', country: 'US' },
  { code: 'TPA', city: 'Tampa', country: 'US' }, { code: 'PIT', city: 'Pittsburgh', country: 'US' },
  { code: 'CVG', city: 'Cincinnati', country: 'US' }, { code: 'MCI', city: 'Kansas City', country: 'US' },
  { code: 'CLE', city: 'Cleveland', country: 'US' }, { code: 'STL', city: 'St. Louis', country: 'US' },
  { code: 'RDU', city: 'Raleigh', country: 'US' }, { code: 'IND', city: 'Indianapolis', country: 'US' },
  { code: 'CMH', city: 'Columbus', country: 'US' }, { code: 'SMF', city: 'Sacramento', country: 'US' },
  { code: 'SAT', city: 'San Antonio', country: 'US' }, { code: 'BWI', city: 'Baltimore', country: 'US' },
  { code: 'OAK', city: 'Oakland', country: 'US' }, { code: 'FLL', city: 'Fort Lauderdale', country: 'US' },
  { code: 'ANC', city: 'Anchorage', country: 'US' }, { code: 'ABQ', city: 'Albuquerque', country: 'US' },
  { code: 'MEM', city: 'Memphis', country: 'US' },
  { code: 'YYZ', city: 'Toronto', country: 'CA' }, { code: 'YVR', city: 'Vancouver', country: 'CA' },
  { code: 'YUL', city: 'Montreal', country: 'CA' }, { code: 'YYC', city: 'Calgary', country: 'CA' },
  { code: 'YEG', city: 'Edmonton', country: 'CA' }, { code: 'YOW', city: 'Ottawa', country: 'CA' },
  { code: 'YWG', city: 'Winnipeg', country: 'CA' }, { code: 'YHZ', city: 'Halifax', country: 'CA' },
  { code: 'MEX', city: 'Mexico City', country: 'MX' }, { code: 'CUN', city: 'Cancun', country: 'MX' },
  { code: 'GDL', city: 'Guadalajara', country: 'MX' }, { code: 'MTY', city: 'Monterrey', country: 'MX' },
  { code: 'TIJ', city: 'Tijuana', country: 'MX' }, { code: 'PVR', city: 'Puerto Vallarta', country: 'MX' },
  { code: 'SJD', city: 'Los Cabos', country: 'MX' },
  { code: 'HAV', city: 'Havana', country: 'CU' }, { code: 'PUJ', city: 'Punta Cana', country: 'DO' },
  { code: 'SDQ', city: 'Santo Domingo', country: 'DO' }, { code: 'SJU', city: 'San Juan', country: 'PR' },
  { code: 'NAS', city: 'Nassau', country: 'BS' }, { code: 'KIN', city: 'Kingston', country: 'JM' },
  { code: 'MBJ', city: 'Montego Bay', country: 'JM' }, { code: 'BGI', city: 'Bridgetown', country: 'BB' },
  { code: 'POS', city: 'Port of Spain', country: 'TT' }, { code: 'AUA', city: 'Aruba', country: 'AW' },
  { code: 'CUR', city: 'Curacao', country: 'CW' },
  { code: 'PTY', city: 'Panama City', country: 'PA' }, { code: 'SJO', city: 'San Jose', country: 'CR' },
  { code: 'GUA', city: 'Guatemala City', country: 'GT' }, { code: 'SAL', city: 'San Salvador', country: 'SV' },
  { code: 'MGA', city: 'Managua', country: 'NI' }, { code: 'BZE', city: 'Belize City', country: 'BZ' },

  // South America
  { code: 'BOG', city: 'Bogota', country: 'CO' }, { code: 'LIM', city: 'Lima', country: 'PE' },
  { code: 'SCL', city: 'Santiago', country: 'CL' }, { code: 'BSB', city: 'Brasilia', country: 'BR' },
  { code: 'UIO', city: 'Quito', country: 'EC' }, { code: 'GYE', city: 'Guayaquil', country: 'EC' },
  { code: 'CCS', city: 'Caracas', country: 'VE' }, { code: 'MVD', city: 'Montevideo', country: 'UY' },
  { code: 'ASU', city: 'Asuncion', country: 'PY' }, { code: 'LPB', city: 'La Paz', country: 'BO' },
  { code: 'VVI', city: 'Santa Cruz', country: 'BO' },
  { code: 'CLO', city: 'Cali', country: 'CO' }, { code: 'MDE', city: 'Medellin', country: 'CO' },
  { code: 'COR', city: 'Cordoba', country: 'AR' }, { code: 'REC', city: 'Recife', country: 'BR' },
  { code: 'SSA', city: 'Salvador', country: 'BR' }, { code: 'FOR', city: 'Fortaleza', country: 'BR' },
  { code: 'CNF', city: 'Belo Horizonte', country: 'BR' }, { code: 'POA', city: 'Porto Alegre', country: 'BR' },
  { code: 'CWB', city: 'Curitiba', country: 'BR' },

  // Europe
  { code: 'MAD', city: 'Madrid', country: 'ES' }, { code: 'BCN', city: 'Barcelona', country: 'ES' },
  { code: 'BER', city: 'Berlin', country: 'DE' }, { code: 'MUC', city: 'Munich', country: 'DE' },
  { code: 'FRA', city: 'Frankfurt', country: 'DE' }, { code: 'HAM', city: 'Hamburg', country: 'DE' },
  { code: 'CGN', city: 'Cologne', country: 'DE' }, { code: 'DUS', city: 'Dusseldorf', country: 'DE' },
  { code: 'STR', city: 'Stuttgart', country: 'DE' }, { code: 'AMS', city: 'Amsterdam', country: 'NL' },
  { code: 'VIE', city: 'Vienna', country: 'AT' }, { code: 'ZRH', city: 'Zurich', country: 'CH' },
  { code: 'GVA', city: 'Geneva', country: 'CH' }, { code: 'BRU', city: 'Brussels', country: 'BE' },
  { code: 'LIS', city: 'Lisbon', country: 'PT' }, { code: 'OPO', city: 'Porto', country: 'PT' },
  { code: 'FAO', city: 'Faro', country: 'PT' }, { code: 'DUB', city: 'Dublin', country: 'IE' },
  { code: 'CPH', city: 'Copenhagen', country: 'DK' }, { code: 'GOT', city: 'Gothenburg', country: 'SE' },
  { code: 'MMX', city: 'Malmo', country: 'SE' }, { code: 'OSL', city: 'Oslo', country: 'NO' },
  { code: 'BGO', city: 'Bergen', country: 'NO' }, { code: 'HEL', city: 'Helsinki', country: 'FI' },
  { code: 'KEF', city: 'Reykjavik', country: 'IS' }, { code: 'WAW', city: 'Warsaw', country: 'PL' },
  { code: 'KRK', city: 'Krakow', country: 'PL' }, { code: 'GDN', city: 'Gdansk', country: 'PL' },
  { code: 'WRO', city: 'Wroclaw', country: 'PL' }, { code: 'PRG', city: 'Prague', country: 'CZ' },
  { code: 'BUD', city: 'Budapest', country: 'HU' }, { code: 'OTP', city: 'Bucharest', country: 'RO' },
  { code: 'CLJ', city: 'Cluj-Napoca', country: 'RO' }, { code: 'SOF', city: 'Sofia', country: 'BG' },
  { code: 'ATH', city: 'Athens', country: 'GR' }, { code: 'SKG', city: 'Thessaloniki', country: 'GR' },
  { code: 'HER', city: 'Heraklion', country: 'GR' }, { code: 'RHO', city: 'Rhodes', country: 'GR' },
  { code: 'LED', city: 'St. Petersburg', country: 'RU' }, { code: 'KBP', city: 'Kyiv', country: 'UA' },
  { code: 'MSQ', city: 'Minsk', country: 'BY' }, { code: 'VNO', city: 'Vilnius', country: 'LT' },
  { code: 'RIX', city: 'Riga', country: 'LV' }, { code: 'TLL', city: 'Tallinn', country: 'EE' },
  { code: 'BEG', city: 'Belgrade', country: 'RS' }, { code: 'ZAG', city: 'Zagreb', country: 'HR' },
  { code: 'SPU', city: 'Split', country: 'HR' }, { code: 'DBV', city: 'Dubrovnik', country: 'HR' },
  { code: 'LJU', city: 'Ljubljana', country: 'SI' }, { code: 'SJJ', city: 'Sarajevo', country: 'BA' },
  { code: 'SKP', city: 'Skopje', country: 'MK' },
  { code: 'NCE', city: 'Nice', country: 'FR' }, { code: 'LYS', city: 'Lyon', country: 'FR' },
  { code: 'MRS', city: 'Marseille', country: 'FR' }, { code: 'TLS', city: 'Toulouse', country: 'FR' },
  { code: 'NTE', city: 'Nantes', country: 'FR' }, { code: 'BOD', city: 'Bordeaux', country: 'FR' },
  { code: 'VCE', city: 'Venice', country: 'IT' }, { code: 'FLR', city: 'Florence', country: 'IT' },
  { code: 'NAP', city: 'Naples', country: 'IT' }, { code: 'BLQ', city: 'Bologna', country: 'IT' },
  { code: 'TRN', city: 'Turin', country: 'IT' }, { code: 'PMO', city: 'Palermo', country: 'IT' },
  { code: 'VLC', city: 'Valencia', country: 'ES' }, { code: 'SVQ', city: 'Seville', country: 'ES' },
  { code: 'BIO', city: 'Bilbao', country: 'ES' }, { code: 'AGP', city: 'Malaga', country: 'ES' },
  { code: 'PMI', city: 'Palma de Mallorca', country: 'ES' }, { code: 'IBZ', city: 'Ibiza', country: 'ES' },
  { code: 'LPA', city: 'Gran Canaria', country: 'ES' }, { code: 'TFS', city: 'Tenerife', country: 'ES' },
  { code: 'LUX', city: 'Luxembourg', country: 'LU' }, { code: 'MLA', city: 'Malta', country: 'MT' },
  { code: 'EDI', city: 'Edinburgh', country: 'GB' }, { code: 'MAN', city: 'Manchester', country: 'GB' },
  { code: 'GLA', city: 'Glasgow', country: 'GB' }, { code: 'BHX', city: 'Birmingham', country: 'GB' },
  { code: 'BRS', city: 'Bristol', country: 'GB' }, { code: 'BFS', city: 'Belfast', country: 'GB' },
  { code: 'LBA', city: 'Leeds', country: 'GB' }, { code: 'NCL', city: 'Newcastle', country: 'GB' },

  // Middle East
  { code: 'DXB', city: 'Dubai', country: 'AE' }, { code: 'DOH', city: 'Doha', country: 'QA' },
  { code: 'AUH', city: 'Abu Dhabi', country: 'AE' }, { code: 'RUH', city: 'Riyadh', country: 'SA' },
  { code: 'JED', city: 'Jeddah', country: 'SA' }, { code: 'KWI', city: 'Kuwait City', country: 'KW' },
  { code: 'BAH', city: 'Manama', country: 'BH' }, { code: 'MCT', city: 'Muscat', country: 'OM' },
  { code: 'AMM', city: 'Amman', country: 'JO' }, { code: 'BEY', city: 'Beirut', country: 'LB' },
  { code: 'TLV', city: 'Tel Aviv', country: 'IL' }, { code: 'IKA', city: 'Tehran', country: 'IR' },
  { code: 'BGW', city: 'Baghdad', country: 'IQ' }, { code: 'EBL', city: 'Erbil', country: 'IQ' },

  // Africa
  { code: 'CAI', city: 'Cairo', country: 'EG' }, { code: 'JNB', city: 'Johannesburg', country: 'ZA' },
  { code: 'CPT', city: 'Cape Town', country: 'ZA' }, { code: 'NBO', city: 'Nairobi', country: 'KE' },
  { code: 'LOS', city: 'Lagos', country: 'NG' }, { code: 'ABV', city: 'Abuja', country: 'NG' },
  { code: 'ADD', city: 'Addis Ababa', country: 'ET' }, { code: 'CMN', city: 'Casablanca', country: 'MA' },
  { code: 'RAK', city: 'Marrakesh', country: 'MA' }, { code: 'TUN', city: 'Tunis', country: 'TN' },
  { code: 'ALG', city: 'Algiers', country: 'DZ' }, { code: 'ACC', city: 'Accra', country: 'GH' },
  { code: 'DSS', city: 'Dakar', country: 'SN' }, { code: 'ABJ', city: 'Abidjan', country: 'CI' },
  { code: 'FIH', city: 'Kinshasa', country: 'CD' }, { code: 'LAD', city: 'Luanda', country: 'AO' },
  { code: 'DAR', city: 'Dar es Salaam', country: 'TZ' }, { code: 'EBB', city: 'Kampala', country: 'UG' },
  { code: 'KGL', city: 'Kigali', country: 'RW' }, { code: 'LUN', city: 'Lusaka', country: 'ZM' },
  { code: 'HRE', city: 'Harare', country: 'ZW' }, { code: 'MPM', city: 'Maputo', country: 'MZ' },
  { code: 'WDH', city: 'Windhoek', country: 'NA' }, { code: 'GBE', city: 'Gaborone', country: 'BW' },
  { code: 'MRU', city: 'Mauritius', country: 'MU' }, { code: 'SEZ', city: 'Seychelles', country: 'SC' },
  { code: 'KRT', city: 'Khartoum', country: 'SD' }, { code: 'MJI', city: 'Tripoli', country: 'LY' },

  // Asia
  { code: 'NGO', city: 'Nagoya', country: 'JP' }, { code: 'FUK', city: 'Fukuoka', country: 'JP' },
  { code: 'CTS', city: 'Sapporo', country: 'JP' }, { code: 'OKA', city: 'Okinawa', country: 'JP' },
  { code: 'ICN', city: 'Seoul-Incheon', country: 'KR' }, { code: 'PUS', city: 'Busan', country: 'KR' },
  { code: 'CAN', city: 'Guangzhou', country: 'CN' }, { code: 'SZX', city: 'Shenzhen', country: 'CN' },
  { code: 'CTU', city: 'Chengdu', country: 'CN' }, { code: 'CKG', city: 'Chongqing', country: 'CN' },
  { code: 'XIY', city: "Xi'an", country: 'CN' }, { code: 'HGH', city: 'Hangzhou', country: 'CN' },
  { code: 'NKG', city: 'Nanjing', country: 'CN' }, { code: 'TAO', city: 'Qingdao', country: 'CN' },
  { code: 'XMN', city: 'Xiamen', country: 'CN' }, { code: 'KMG', city: 'Kunming', country: 'CN' },
  { code: 'WUH', city: 'Wuhan', country: 'CN' }, { code: 'HKG', city: 'Hong Kong', country: 'HK' },
  { code: 'HKT', city: 'Phuket', country: 'TH' }, { code: 'CNX', city: 'Chiang Mai', country: 'TH' },
  { code: 'SIN', city: 'Singapore', country: 'SG' }, { code: 'KUL', city: 'Kuala Lumpur', country: 'MY' },
  { code: 'DPS', city: 'Bali', country: 'ID' }, { code: 'MNL', city: 'Manila', country: 'PH' },
  { code: 'CEB', city: 'Cebu', country: 'PH' }, { code: 'SGN', city: 'Ho Chi Minh City', country: 'VN' },
  { code: 'HAN', city: 'Hanoi', country: 'VN' }, { code: 'BOM', city: 'Mumbai', country: 'IN' },
  { code: 'DEL', city: 'New Delhi', country: 'IN' }, { code: 'BLR', city: 'Bangalore', country: 'IN' },
  { code: 'MAA', city: 'Chennai', country: 'IN' }, { code: 'HYD', city: 'Hyderabad', country: 'IN' },
  { code: 'CCU', city: 'Kolkata', country: 'IN' }, { code: 'COK', city: 'Kochi', country: 'IN' },
  { code: 'GOI', city: 'Goa', country: 'IN' }, { code: 'CMB', city: 'Colombo', country: 'LK' },
  { code: 'DAC', city: 'Dhaka', country: 'BD' }, { code: 'KTM', city: 'Kathmandu', country: 'NP' },
  { code: 'ISB', city: 'Islamabad', country: 'PK' }, { code: 'KHI', city: 'Karachi', country: 'PK' },
  { code: 'LHE', city: 'Lahore', country: 'PK' }, { code: 'MLE', city: 'Male', country: 'MV' },
  { code: 'PNH', city: 'Phnom Penh', country: 'KH' }, { code: 'VTE', city: 'Vientiane', country: 'LA' },
  { code: 'RGN', city: 'Yangon', country: 'MM' }, { code: 'ULN', city: 'Ulaanbaatar', country: 'MN' },
  { code: 'ALA', city: 'Almaty', country: 'KZ' }, { code: 'TAS', city: 'Tashkent', country: 'UZ' },
  { code: 'GYD', city: 'Baku', country: 'AZ' }, { code: 'TBS', city: 'Tbilisi', country: 'GE' },
  { code: 'EVN', city: 'Yerevan', country: 'AM' },

  // Oceania
  { code: 'SYD', city: 'Sydney', country: 'AU' }, { code: 'MEL', city: 'Melbourne', country: 'AU' },
  { code: 'BNE', city: 'Brisbane', country: 'AU' }, { code: 'PER', city: 'Perth', country: 'AU' },
  { code: 'ADL', city: 'Adelaide', country: 'AU' }, { code: 'AKL', city: 'Auckland', country: 'NZ' },
  { code: 'WLG', city: 'Wellington', country: 'NZ' }, { code: 'CHC', city: 'Christchurch', country: 'NZ' },
  { code: 'ZQN', city: 'Queenstown', country: 'NZ' }, { code: 'NAN', city: 'Fiji', country: 'FJ' },
  { code: 'POM', city: 'Port Moresby', country: 'PG' },
]

// Hand-written alias list: local names and common misspellings, keyed by the
// place's display city name (case-sensitive match against `city` above).
const ALIASES_BY_CITY = {
  Tokyo: ['tokio'],
  Barcelona: ['barcelone'],
  Lisbon: ['lisboa', 'lisbonne'],
  Munich: ['münchen', 'munchen'],
  Rome: ['roma'],
  Vienna: ['wien'],
  Prague: ['praha'],
  Warsaw: ['warszawa'],
  Copenhagen: ['kobenhavn', 'københavn'],
  Florence: ['firenze'],
  Venice: ['venezia'],
  Naples: ['napoli'],
  Seville: ['sevilla'],
  Cologne: ['köln', 'koln'],
  Athens: ['athina'],
  Bucharest: ['bucuresti', 'bucurești'],
  'Cluj-Napoca': ['cluj'],
  'New York': ['nyc'],
  'Los Angeles': ['la'],
  'San Francisco': ['sf'],
  Bangkok: ['bkk'],
  'Hong Kong': ['hk'],
}

// Fix round 1, ruling F: two entries share the display name "San Jose" (SJC, US; SJO, Costa
// Rica). ALIAS_MAP in places.ts keeps the first one encountered in places.json's sorted-by-code
// order -- SJC sorts before SJO -- so plain "san jose" always resolves to SJC; SJO needs its own
// disambiguating alias since it can never win the bare name. Keyed by `code` (not `city`, which
// collides) for exactly this reason.
const ALIASES_BY_CODE = {
  SJO: ['san jose costa rica', 'san josé costa rica'],
}

/**
 * What to ask Nominatim for, where `<city>,<country>` is not the city.
 *
 * Three kinds of exception, all found by reading the misses from an actual
 * run rather than guessed: a display name that is a disambiguation rather
 * than a place ("Seoul-Incheon"), an entry whose `city` is the ISLAND or
 * COUNTRY and whose centre should be its actual city (Mauritius -> Port
 * Louis, Fiji -> Nadi, Malta -> Valletta), and a city whose English name
 * Nominatim does not index ("Los Cabos" -> "San José del Cabo").
 *
 * Keyed by place code, because the display name is exactly what is being
 * overridden here.
 */
const GEOCODE_QUERY_BY_CODE = {
  ICN: 'Seoul, KR',
  MRU: 'Port Louis, MU',
  SEZ: 'Victoria, SC',
  NAN: 'Nadi, FJ',
  MLA: 'Valletta, MT',
  SJD: 'San José del Cabo, MX',
  LPA: 'Las Palmas de Gran Canaria, ES',
  TFS: 'Santa Cruz de Tenerife, ES',
  DPS: 'Denpasar, ID',
  GOI: 'Panaji, IN',
  AUA: 'Oranjestad, AW',
  CUR: 'Willemstad, CW',
  MJI: 'Tripoli, LY',
  POS: 'Port of Spain, TT',
}

function loadGeocodeCache() {
  if (!existsSync(GEOCODE_CACHE_PATH)) return {}
  return JSON.parse(readFileSync(GEOCODE_CACHE_PATH, 'utf8'))
}

function saveGeocodeCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(GEOCODE_CACHE_PATH, JSON.stringify(sorted, null, 2) + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One Nominatim lookup, cached by the exact query string. Returns
 * `{ lat, lon }` rounded to four decimals (~11 m, far finer than a city
 * centre is even meaningful to) or `null` for a query it cannot answer — a
 * null is cached too, so a rebuild does not retry a known miss and the
 * misses are visible in the committed cache rather than only in a log.
 *
 * Nominatim's usage policy: at most one request a second, and a real
 * `User-Agent`. Both are honoured here; `cached` tells the caller whether it
 * owes the service that second of politeness.
 */
async function geocode(query, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, query)) return { center: cache[query], cached: true }
  const url = new URL(NOMINATIM_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')
  const res = await fetch(url, { headers: { 'User-Agent': 'globetrotty-build' } })
  if (!res.ok) throw new Error(`nominatim: HTTP ${res.status} for ${query}`)
  const body = await res.json()
  const first = Array.isArray(body) ? body[0] : undefined
  const lat = first ? Number(first.lat) : NaN
  const lon = first ? Number(first.lon) : NaN
  const center = Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 }
    : null
  cache[query] = center
  return { center, cached: false }
}

/** Fills `center` on every place, in place, and returns the queries that came back empty. */
async function addCenters(places, warnings) {
  const cache = loadGeocodeCache()
  let fetched = 0
  try {
    for (const p of places) {
      const query = GEOCODE_QUERY_BY_CODE[p.code] ?? `${p.city}, ${p.country}`
      const { center, cached } = await geocode(query, cache)
      p.center = center
      if (center === null) warnings.push(`${p.city} (${p.code}): Nominatim had no result for "${query}"; center is null`)
      if (!cached) {
        fetched++
        await sleep(1100)
      }
    }
  } finally {
    // Saved even on a throw: a part-finished run must not cost the places it
    // already paid for.
    saveGeocodeCache(cache)
  }
  console.log(`${fetched} place(s) geocoded live; ${places.length - fetched} came from scripts/.cache/geocode.json`)
}

async function main() {
  console.log(`Downloading ${AIRPORTS_CSV_URL} ...`)
  const res = await fetch(AIRPORTS_CSV_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const text = await res.text()
  const lines = text.split('\n').filter((l) => l.length > 0)
  const header = parseCsvLine(lines[0])
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))

  /** @type {Map<string, string[]>} iata_code -> csv row */
  const byIata = new Map()
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line)
    const code = f[idx.iata_code]
    if (code) byIata.set(code, f)
  }

  const places = []
  const warnings = []

  for (const m of METRO_PLACES) {
    if (!byIata.has(m.sampleAirport)) warnings.push(`metro ${m.code} (${m.city}): sample airport ${m.sampleAirport} not found in current dataset`)
    places.push({ code: m.code, city: m.city, country: m.country, region: m.region, hotelName: m.city, aliases: [] })
  }

  for (const entry of CURATED_PLACES) {
    const row = byIata.get(entry.code)
    if (!row) { warnings.push(`${entry.city} (${entry.code}): not found in current large-airport dataset`); continue }
    if (row[idx.type] !== 'large_airport') warnings.push(`${entry.city} (${entry.code}): is type '${row[idx.type]}', not large_airport, in the current dataset`)
    const region = regionFor(row[idx.continent], entry.country)
    if (!region) { warnings.push(`${entry.city} (${entry.code}): unknown continent '${row[idx.continent]}'`); continue }
    places.push({ code: entry.code, city: entry.city, country: entry.country, region, hotelName: entry.city, aliases: [] })
  }

  // Kyoto: no large airport of its own; dedicated alias entry onto Osaka's
  // metro code, per ledger ruling 3.
  places.push({ code: 'OSA', city: 'Kyoto', country: 'JP', region: 'asia', hotelName: 'Kyoto', aliases: ['kioto', 'kyōto'] })

  for (const p of places) {
    p.aliases = [...new Set([...p.aliases, ...(ALIASES_BY_CITY[p.city] ?? []), ...(ALIASES_BY_CODE[p.code] ?? [])])]
  }

  await addCenters(places, warnings)

  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} warning(s):`)
    for (const w of warnings) console.warn(`  - ${w}`)
  }

  // Sort by code; keep the Osaka entry before its Kyoto alias so a plain
  // code lookup resolves to the primary (Osaka) place.
  places.sort((a, b) => {
    if (a.code !== b.code) return a.code.localeCompare(b.code)
    return a.city === 'Kyoto' ? 1 : -1
  })

  console.log(`\nWriting ${places.length} places to ${OUT_PATH}`)
  writeFileSync(OUT_PATH, JSON.stringify(places, null, 2) + '\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
