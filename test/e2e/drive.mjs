import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createClient } from '@supabase/supabase-js'

const envText = fs.readFileSync('/Users/danneciu/Desktop/Desktop/apps/globtrotty/.env.local', 'utf8')
const env = Object.fromEntries(envText.split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }))
const SITE = process.env.SITE ?? 'https://globtrotty.netlify.app'
const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0]
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const email = `e2e-${Date.now()}@example.com`
const password = 'E2e-' + Math.random().toString(36).slice(2) + 'Xx9!'
const out = (name) => `${process.cwd()}/${name}`
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

function cookieChunks(session) {
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const name = `sb-${ref}-auth-token`
  const size = 3180
  if (value.length <= size) return [{ name, value }]
  const chunks = []
  for (let i = 0; i * size < value.length; i++) chunks.push({ name: `${name}.${i}`, value: value.slice(i * size, (i + 1) * size) })
  return chunks
}

let userId = null
try {
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  userId = created.user.id
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: signed, error: signErr } = await anon.auth.signInWithPassword({ email, password })
  if (signErr) throw signErr
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 1440, height: 900 } })
  const page = await browser.newPage()
  const host = new URL(SITE).hostname
  await page.setCookie(...cookieChunks(signed.session).map((c) => ({ ...c, domain: host, path: '/', secure: SITE.startsWith('https'), httpOnly: false, sameSite: 'Lax' })))
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })

  await page.goto(`${SITE}/c/new`, { waitUntil: 'networkidle2', timeout: 60000 })
  log('landed on', page.url())
  await page.screenshot({ path: out('01-landing.png') })

  const MSG = 'i need to be in tokio with my wife on 20th of nov, from barcelona, and back in barcelona sunday 6th of december. i would like to fly on the long trips premium economie and on short economy, and for acomodation i am staying most of the time in tokio and i would like to visit everything turistic but not change a lot of hotels but i will also travel in kioto, i will visit the nintendo museum on the 3rd'
  await page.waitForSelector('textarea', { timeout: 30000 })
  await page.type('textarea', MSG, { delay: 0 })
  const t0 = Date.now()
  await page.keyboard.press('Enter')
  const split = await page.waitForSelector('.split-pane-chat, .results-pane, .results-skeleton, [data-pending="true"]', { timeout: 15000 }).then(() => Date.now() - t0).catch(() => null)
  log('optimistic switch after ms:', split)
  await page.screenshot({ path: out('02-after-send.png') })
  const cards = await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Select' && !b.disabled), { timeout: 120000, polling: 200 }).then(() => Date.now() - t0).catch(() => null)
  log('first flight cards (enabled Select) after ms:', cards, 'url', page.url())
  if (cards === null) { await page.screenshot({ path: out('03-timeout.png'), fullPage: true }); log('TEXT:', (await page.evaluate(() => document.body.innerText)).slice(0, 600).replace(/\n+/g, ' | ')) }
  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: out('03-flights.png'), fullPage: false })
  const selects = await page.$$('button')
  let selectBtn = null
  for (const b of selects) { const t = (await b.evaluate((e) => e.textContent))?.trim(); const d = await b.evaluate((e) => e.disabled); if (t === 'Select' && !d) { selectBtn = b; break } }
  if (!selectBtn) throw new Error('no Select button found')
  const t1 = Date.now()
  await selectBtn.click()
  const optimistic = await page.waitForFunction(() => document.body.innerText.includes('Searching hotels') || document.querySelector('[data-pending="true"]') !== null, { timeout: 5000 }).then(() => Date.now() - t1).catch(() => null)
  log('select optimistic after ms:', optimistic)
  await page.screenshot({ path: out('04-after-select.png') })
  const hotels = await page.waitForFunction(() => /\d+ hotels shown|hotels in Tokyo|Here are hotels|places in Tokyo/i.test(document.body.innerText), { timeout: 90000 }).then(() => Date.now() - t1).catch(() => null)
  log('hotels after ms:', hotels)
  await new Promise((r) => setTimeout(r, 2500))
  await page.screenshot({ path: out('05-hotels.png') })
  const skeletonLeft = await page.$$eval('.results-skeleton', (els) => els.length)
  const disabledSelects = await page.$$eval('button', (bs) => bs.filter((b) => b.textContent?.trim() === 'Select' && b.disabled).length)
  const enabledSelects = await page.$$eval('button', (bs) => bs.filter((b) => b.textContent?.trim() === 'Select' && !b.disabled).length)
  log('skeletons left:', skeletonLeft, 'Select enabled:', enabledSelects, 'disabled:', disabledSelects)
  await page.screenshot({ path: out('06-hotels-full.png'), fullPage: true })
  log('errors:', errors.length ? errors.slice(0, 8).join('\n  ') : 'none')
  await browser.close()
} finally {
  if (userId) {
    await admin.from('conversations').delete().eq('user_id', userId)
    await admin.auth.admin.deleteUser(userId)
    log('cleaned up test user')
  }
}
