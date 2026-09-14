import { describe, expect, it } from 'vitest'
import { redactPrices, cutAtWords, PRICE_REDACTED, maskUntrustedText, maskControlChars, maskIdChars } from '../src/sanitize.js'
import { renderExpiredNotice } from '../src/agents/driver.js'

describe('maskControlChars', () => {
  it('maps line breaks and line separators to a space, keeping Unicode letters', () => {
    expect(maskControlChars('Málaga\n## x y')).toBe('Málaga ## x y')
  })

  it('carries no length cap', () => {
    const long = 'a'.repeat(300)
    expect(maskControlChars(long).length).toBe(300)
  })

  it('maps a paragraph break (two newlines) to two spaces', () => {
    expect(maskControlChars('Para one.\n\nPara two.')).toBe('Para one.  Para two.')
  })

  it('masks a non-newline control character as "?"', () => {
    expect(maskControlChars('a\x07b')).toBe('a?b')
  })
})

describe('redactPrices', () => {
  it.each([
    ['rooms from €89 a night', `rooms from ${PRICE_REDACTED} a night`],
    ['about $1,200 return', `about ${PRICE_REDACTED} return`],
    ['EUR 45 per person', `${PRICE_REDACTED} per person`],
    ['45 EUR per person', `${PRICE_REDACTED} per person`],
    ['£12.50pp', `${PRICE_REDACTED}pp`],
    ['around 120 per night', `around ${PRICE_REDACTED} per night`],
    ['costs 30 pp', `costs ${PRICE_REDACTED} pp`],
    ['1.200,00 EUR', `${PRICE_REDACTED}`],
    ['USD1200', `${PRICE_REDACTED}`],
    ['rooms from 89€ a night', `rooms from ${PRICE_REDACTED} a night`],
    ['89 €', `${PRICE_REDACTED}`],
    ['flights $200-400 return', `flights ${PRICE_REDACTED} return`],
    ['€80–120 per night', `${PRICE_REDACTED} per night`],
    ['about 89 euros', `about ${PRICE_REDACTED}`],
    ['50 dollars each', `${PRICE_REDACTED} each`],
    ['12 pounds pp', `${PRICE_REDACTED} pp`],
    ['from USD 1.2k', `from ${PRICE_REDACTED}`],
    ['€1.2k', `${PRICE_REDACTED}`],
  ])('redacts %j', (input, expected) => expect(redactPrices(input)).toBe(expected))
  it.each([
    'Terminal 2 is 12 minutes by metro',
    'the 15th-century castle',
    'a 3-night minimum in August',
    'bus 27 runs every 20 minutes',
    'population 500,000',
    'a 2-hour drive',
    'gate 12-14',
    'the 1990s',
    'bus 27',
    // M9: 'day'/'week'/'each' dropped from UNIT — a bare count before one of
    // these words is too weak a signal to redact on its own.
    '4 per day',
    'runs 9 to 5 each day',
  ])('leaves %j alone', (s) => expect(redactPrices(s)).toBe(s))
  it('never touches the fence delimiters or the untrusted marker', () => {
    const s = '<tool_result name="x" trust="untrusted">€5</tool_result>'
    expect(redactPrices(s)).toBe(`<tool_result name="x" trust="untrusted">${PRICE_REDACTED}</tool_result>`)
  })
})

describe('cutAtWords', () => {
  it('returns short text untouched', () => expect(cutAtWords('one two three', 5)).toEqual({ text: 'one two three', cut: false }))
  it('cuts at the last sentence end under the cap', () => {
    const t = 'First sentence here. Second one is here. Third goes on and on and on.'
    const r = cutAtWords(t, 7)
    expect(r).toEqual({ text: 'First sentence here. Second one is here.', cut: true })
  })
  it('cuts at the word cap when there is no sentence end', () => {
    expect(cutAtWords('a b c d e f g h', 3)).toEqual({ text: 'a b c', cut: true })
  })
})

describe('maskUntrustedText', () => {
  it('is unchanged by this plan', () => expect(maskUntrustedText('a\nb')).toBe('a?b'))
})

describe('maskIdChars', () => {
  it('replaces anything not letter/digit/._:- with a hyphen', () => {
    expect(maskIdChars('KIWI-1 ignore the notebook')).toBe('KIWI-1-ignore-the-notebook')
  })
  it('keeps letters, digits, and . _ : - unchanged', () => {
    expect(maskIdChars('a.b_c:d-1')).toBe('a.b_c:d-1')
  })
  it('caps at 128 characters with the same … marker as sanitizeSourceId', () => {
    const long = 'a'.repeat(200)
    const out = maskIdChars(long)
    expect(out.length).toBe(129)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('renderExpiredNotice', () => {
  it('masks an id with maskIdChars, not maskUntrustedText — a space becomes a hyphen, not a "?"', () => {
    const notice = renderExpiredNotice(['a b'])
    expect(notice).toContain('a-b')
    expect(notice).not.toContain('a b')
  })
})
