/**
 * Trip-stage pass, section 6: the browser harness, and the gate for the whole pass.
 *
 * It drives a REAL browser against a LOCAL `next dev` on port 3100 (`scripts/e2e.sh` starts it),
 * through the whole trip: send, choose a flight, narrow the list, choose a stay, accept. Every
 * assertion is about what is on the screen and when, because every bug this pass exists to fix
 * was one a unit test could not see.
 *
 * AUTHORISED, same scope as `test/rls.live.test.ts`: it creates a throwaway email+password user
 * with the service-role key, signs in, drives the app as that user, and deletes the user and its
 * rows in a `finally`. It never runs against production — the site is fixed to localhost below
 * and the script refuses anything else.
 *
 * Run: `bash scripts/e2e.sh`, or `E2E=1 node test/e2e/trip.e2e.mjs` with a dev server already up.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createClient } from '@supabase/supabase-js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'test/e2e/out')
const SITE = process.env.E2E_SITE ?? 'http://localhost:3100'
const CHROME = process.env.E2E_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (process.env.E2E !== '1') {
  console.error('Refusing to run without E2E=1. See the file comment.')
  process.exit(2)
}
if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(SITE)) {
  console.error(`Refusing to run against ${SITE}: this harness is for a LOCAL dev server only.`)
  process.exit(2)
}

/** `.env.local`, parsed here because a plain node script gets none of Next's own loading. */
function readEnv() {
  const text = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  const out = {}
  for (const line of text.split('\n')) {
    if (!line.includes('=') || line.trimStart().startsWith('#')) continue
    const i = line.indexOf('=')
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '')
  }
  return out
}

const env = readEnv()
for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) {
    // The NAME only. Never a value, ever.
    console.error(`.env.local is missing ${key}`)
    process.exit(2)
  }
}

const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0]
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const email = `e2e-${Date.now()}@example.com`
const password = `E2e-${Math.random().toString(36).slice(2)}Xx9!`

const started = Date.now()
const log = (...a) => console.log(`${String(Date.now() - started).padStart(6)}ms`, ...a)

const failures = []
function check(ok, what, detail = '') {
  if (ok) log(`  PASS  ${what}${detail ? ` — ${detail}` : ''}`)
  else {
    log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
    failures.push(what)
  }
}

/** The auth cookie `@supabase/ssr` reads, built from a real `signInWithPassword` session. */
function cookieChunks(session) {
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  const name = `sb-${ref}-auth-token`
  const size = 3180
  if (value.length <= size) return [{ name, value }]
  const chunks = []
  for (let i = 0; i * size < value.length; i++) {
    chunks.push({ name: `${name}.${i}`, value: value.slice(i * size, (i + 1) * size) })
  }
  return chunks
}

/** Waits for `fn` to be true in the page, returning the ms it took or `null` on a timeout. */
async function waitFor(page, fn, timeout, arg) {
  const t0 = Date.now()
  try {
    await page.waitForFunction(fn, { timeout, polling: 50 }, arg)
    return Date.now() - t0
  } catch {
    return null
  }
}

const within = (ms, budget) => ms !== null && ms <= budget

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  log(`  shot  ${file}`)
}

async function clickButton(page, label, { nth = 0 } = {}) {
  const handles = await page.$$('button')
  let seen = 0
  for (const handle of handles) {
    const text = await handle.evaluate((e) => e.textContent?.trim())
    const disabled = await handle.evaluate((e) => e.disabled)
    if (text === label && !disabled) {
      if (seen === nth) {
        await handle.click()
        return true
      }
      seen++
    }
  }
  return false
}

fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true })

let userId = null
let browser = null
try {
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  userId = created.user.id
  log('created the throwaway user')

  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: signed, error: signErr } = await anon.auth.signInWithPassword({ email, password })
  if (signErr) throw signErr

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  const host = new URL(SITE).hostname
  await page.setCookie(...cookieChunks(signed.session).map((c) => ({
    ...c, domain: host, path: '/', secure: false, httpOnly: false, sameSite: 'Lax',
  })))

  // An uncaught exception is a failure of its own — a React loop, a thrown effect, a hydration
  // error. A console line about a resource is not: a hotel photograph the supplier's CDN refuses
  // and a missing favicon say nothing about this pass, so they are reported and not judged.
  const pageErrors = []
  const resourceErrors = []
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text().slice(0, 240)
    if (/Failed to load resource/.test(text)) resourceErrors.push(text)
    else pageErrors.push(`console: ${text}`)
  })

  // The dev server compiles a route the first time it is asked for one, which is several seconds
  // that have nothing to do with how fast the office answers. `/c/<uuid>` redirects straight back
  // to the landing (the id is not hers), so this compiles the conversation page and its whole
  // client bundle without touching a single row.
  log('warming the dev server')
  await page.goto(`${SITE}/c/${randomUUID()}`, { waitUntil: 'networkidle2', timeout: 180_000 })

  // ---------------------------------------------------------------- (a) the landing send
  log('(a) landing send')
  await page.goto(`${SITE}/c/new`, { waitUntil: 'networkidle2', timeout: 120_000 })
  await page.waitForSelector('textarea', { timeout: 60_000 })
  const MSG = 'i need to be in tokyo with my wife on 20th of nov, from barcelona, and back in '
    + 'barcelona sunday 6th of december. premium economy on the long legs, economy on the short '
    + 'ones, and one hotel in tokyo for the whole stay'
  await page.type('textarea', MSG, { delay: 0 })

  await page.keyboard.press('Enter')
  const optimistic = await waitFor(page, () => {
    const split = document.querySelector('.split-shell') !== null
    const bubble = document.querySelector('[data-pending="true"]') !== null
    const skeleton = document.querySelector('.results-skeleton') !== null
    return split && bubble && skeleton
  }, 5_000)
  check(within(optimistic, 300), '(a) split, pending bubble and skeleton within 300 ms', `${optimistic} ms`)

  /*
   * The scenario cap is 120 s and the BUDGET is 60 s — waiting the cap and asserting the budget
   * separately is what stops one slow office turn cascading into twenty failures about a screen
   * nobody ever got to. The number is reported either way.
   */
  const flightsMs = await waitFor(page, () => [...document.querySelectorAll('button')]
    .some((b) => b.textContent?.trim() === 'Select' && !b.disabled), 120_000)
  check(flightsMs !== null, '(a) real flight cards with an enabled Select arrive at all', `${flightsMs} ms`)
  check(within(flightsMs, 60_000), '(a) ... within the 60 s budget', `${flightsMs} ms`)
  await shot(page, 'a-flights')

  // ---------------------------------------------------------------- (b) choosing a flight
  log('(b) Select a flight')
  const clickedFlight = await clickButton(page, 'Select')
  check(clickedFlight, '(b) a flight Select was clickable')
  const flightOptimistic = await waitFor(page, () => {
    const ribbon = document.querySelector('.flight-card-ribbon') !== null
    const note = document.body.innerText.includes('You chose a flight')
    const thinking = document.querySelector('.thinking') !== null
    return ribbon && note && thinking
  }, 5_000)
  check(
    within(flightOptimistic, 100),
    '(b) Selected ribbon, `You chose a flight` and the thinking dots within 100 ms',
    `${flightOptimistic} ms`,
  )
  await shot(page, 'b1-after-select')

  const hotelsMs = await waitFor(page, () => document.querySelectorAll('.hotel-card').length > 0, 120_000)
  check(hotelsMs !== null, '(b) hotel cards arrive at all', `${hotelsMs} ms`)
  check(within(hotelsMs, 60_000), '(b) ... within the 60 s budget', `${hotelsMs} ms`)
  // The pane settles one `router.refresh()` after the row lands; give it a frame to do so.
  await waitFor(page, () => document.querySelectorAll('.results-skeleton').length === 0, 10_000)

  const paneState = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('.hotel-card button')]
      .filter((b) => b.textContent?.trim() === 'Select')
    const chosen = document.querySelector('section[aria-label="Chosen flight"]')
    const hotels = document.querySelector('.hotel-list')
    return {
      skeletons: document.querySelectorAll('.results-skeleton').length,
      hotelSelects: selects.length,
      disabledSelects: selects.filter((b) => b.disabled).length,
      hasChosenFlight: chosen !== null,
      chosenAboveHotels: chosen !== null && hotels !== null
        ? (chosen.compareDocumentPosition(hotels) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : false,
      stage: document.querySelector('.results-pane')?.getAttribute('data-stage') ?? null,
    }
  })
  check(paneState.skeletons === 0, '(b) zero .results-skeleton left', JSON.stringify(paneState.skeletons))
  check(paneState.hotelSelects > 0 && paneState.disabledSelects === 0, '(b) every hotel Select is enabled',
    `${paneState.hotelSelects} selects, ${paneState.disabledSelects} disabled`)
  check(paneState.hasChosenFlight, '(b) a `Chosen flight` card is on screen')
  check(paneState.chosenAboveHotels, '(b) the `Chosen flight` card is above the hotels list')
  check(paneState.stage === 'hotels', '(b) the pane is at the hotels stage', String(paneState.stage))
  await shot(page, 'b2-hotels')

  // ---------------------------------------------------------------- (f) the idle check
  log('(f) main-thread idle check')
  const idle = await page.evaluate(() => new Promise((resolve) => {
    const rendersBefore = window.__gtOptimisticRenders ?? 0
    let frames = 0
    const t0 = performance.now()
    const tick = () => {
      frames++
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick)
      else resolve({ frames, renders: (window.__gtOptimisticRenders ?? 0) - rendersBefore })
    }
    requestAnimationFrame(tick)
  }))
  check(idle.frames < 130, '(f) under 130 frames of work over 2 s', `${idle.frames} frames`)
  check(idle.renders < 40, '(f) no React effect loop in the store', `${idle.renders} provider renders in 2 s`)

  // The other half of (f) — how long a real hotel Select click takes to show on screen — is
  // measured in (d) below, where the click is a real one rather than a synthetic event the main
  // thread would answer in zero milliseconds whatever state it was in.

  // ---------------------------------------------------------------- (c) narrowing the list
  log('(c) type a filter with the flights list expanded')
  const expanded = await clickButton(page, 'Other flights')
  check(expanded, '(c) `Other flights` expands the list she has finished with')
  await waitFor(page, () => document.querySelectorAll('.flight-card').length > 1, 5_000)
  const flightsBefore = await page.$$eval('.flight-card', (els) => els.length)

  await page.waitForSelector('textarea:not([disabled])', { timeout: 60_000 })
  await page.click('textarea')
  await page.type('textarea', 'only direct flights', { delay: 0 })
  await page.keyboard.press('Enter')
  const filterBubble = await waitFor(
    page,
    () => document.body.innerText.includes('only direct flights'),
    5_000,
  )
  check(within(filterBubble, 100), '(c) her words are on screen within 100 ms', `${filterBubble} ms`)
  const narrowed = await waitFor(
    page,
    (before) => document.querySelectorAll('.flight-card').length < before,
    90_000,
    flightsBefore,
  )
  check(narrowed !== null, '(c) the list narrows', `${flightsBefore} cards before, after ${narrowed} ms`)
  await shot(page, 'c-filtered')

  // ---------------------------------------------------------------- (d) choosing a stay
  log('(d) Select a hotel')
  await waitFor(page, () => [...document.querySelectorAll('.hotel-card button')]
    .some((b) => b.textContent?.trim() === 'Select' && !b.disabled), 60_000)
  const hotelHandles = await page.$$('.hotel-card button')
  let clickedHotel = false
  for (const handle of hotelHandles) {
    const text = await handle.evaluate((e) => e.textContent?.trim())
    const disabled = await handle.evaluate((e) => e.disabled)
    if (text === 'Select' && !disabled) {
      await handle.click()
      clickedHotel = true
      break
    }
  }
  check(clickedHotel, '(d) a hotel Select was clickable')
  const hotelOptimistic = await waitFor(page, () => {
    const chosen = document.querySelector('section[aria-label="Chosen hotel"]') !== null
      || document.body.innerText.includes('Putting the trip together')
    return chosen && document.body.innerText.includes('You chose a hotel')
  }, 5_000)
  check(
    within(hotelOptimistic, 100),
    '(d) the chosen stay and `You chose a hotel` within 100 ms',
    `${hotelOptimistic} ms`,
  )
  // (f), second half: this IS the click registering, measured on a real browser click.
  check(within(hotelOptimistic, 100), '(f) a hotel Select click registers within 100 ms',
    `${hotelOptimistic} ms`)
  await shot(page, 'd1-after-hotel')

  const acceptMs = await waitFor(
    page,
    () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Accept this trip'),
    120_000,
  )
  check(acceptMs !== null, '(d) `Accept this trip` appears at all', `${acceptMs} ms`)
  check(within(acceptMs, 60_000), '(d) ... within the 60 s budget', `${acceptMs} ms`)

  const tripState = await page.evaluate(() => ({
    hotelList: document.querySelectorAll('.hotel-list').length,
    otherHotels: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Other hotels'),
    decisionCards: document.querySelectorAll('.trip-card').length,
    stage: document.querySelector('.results-pane')?.getAttribute('data-stage') ?? null,
  }))
  check(tripState.otherHotels && tripState.hotelList <= 1,
    '(d) the hotels list is collapsed under `Other hotels`', JSON.stringify(tripState))
  check(tripState.decisionCards === 1, '(d) the chat shows exactly one decision card',
    `${tripState.decisionCards} cards`)
  check(tripState.stage === 'trip', '(d) the pane is at the trip stage', String(tripState.stage))
  await shot(page, 'd2-trip')

  // ---------------------------------------------------------------- (e) accepting
  log('(e) Accept')
  const clickedAccept = await clickButton(page, 'Accept this trip')
  check(clickedAccept, '(e) `Accept this trip` was clickable')
  const acceptedNote = await waitFor(
    page,
    () => document.body.innerText.includes('You accepted the trip'),
    5_000,
  )
  check(within(acceptedNote, 100), '(e) `You accepted the trip` within 100 ms', `${acceptedNote} ms`)
  await shot(page, 'e1-accepting')

  const endMs = await waitFor(page, () => {
    const text = document.body.innerText
    const links = document.querySelectorAll('.trip-links a, .trip-card-links a').length > 0
    return links || text.includes('Accept the updated trip') || text.includes('Try again')
  }, 120_000)
  check(endMs !== null, '(e) booking links, an updated trip to accept, or a way to retry within 120 s',
    `${endMs} ms`)
  const endState = await page.evaluate(() => ({
    links: document.querySelectorAll('.trip-links a, .trip-card-links a').length,
    primaries: [...document.querySelectorAll('button')]
      .filter((b) => b.className.includes('btn-primary') && !b.disabled).length,
    stage: document.querySelector('.results-pane')?.getAttribute('data-stage') ?? null,
    text: document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '),
  }))
  check(endState.links > 0 || endState.primaries > 0, '(e) no dead end: a link or a primary action exists',
    JSON.stringify({ links: endState.links, primaries: endState.primaries, stage: endState.stage }))
  log('  end state:', endState.text)
  await shot(page, 'e2-booked')
  await page.screenshot({ path: path.join(OUT, 'e3-booked-full.png'), fullPage: true })

  log('resource errors (reported, not judged):', resourceErrors.length)
  log('page errors:', pageErrors.length === 0 ? 'none' : `\n  ${pageErrors.slice(0, 10).join('\n  ')}`)
  check(pageErrors.length === 0, 'no uncaught page errors', String(pageErrors.length))
} finally {
  if (browser) await browser.close()
  if (userId) {
    await admin.from('conversations').delete().eq('user_id', userId)
    await admin.auth.admin.deleteUser(userId)
    log('cleaned up the throwaway user and its rows')
  }
}

log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.length}`)
for (const f of failures) log(`  - ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
