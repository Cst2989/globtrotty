import { loadGoldenCases } from '../src/evals/cases.js'
import { saidNoTwice } from '../src/evals/runner.js'
import { makeSimulatedUser } from '../src/evals/sim-user.js'

const portugal = loadGoldenCases().find((c) => c.id === 'portugal-toddler-01')!
const algarve = loadGoldenCases().find((c) => c.id === 'no-for-1500-03')!

describe('the scripted traveller', () => {
  it('answers a question from the facts she was given, in a sentence', async () => {
    const her = await makeSimulatedUser(portugal.persona).reply('How many nights are you staying?')
    expect(her).toBe('7 nights.')
  })

  it('gives the same answer twice, which is the whole point', async () => {
    const one = await makeSimulatedUser(portugal.persona).reply('And what is your budget?')
    const two = await makeSimulatedUser(portugal.persona).reply('And what is your budget?')
    expect(one).toBe(two)
    // Lower case, because her style says so, which is also why this reads
    // '1500 eur' and not the '1500 EUR' the persona file holds.
    expect(one).toBe('our budget is 1500 eur.')
  })

  it('types in her persona style, and a persona without one gets sentence case', async () => {
    // Her style says lowercase and the answer is lowercase. The Algarve persona
    // says "firm about the budget" and nothing about case, so hers opens with a
    // capital. Until this round `style` was written into every case and read by
    // nothing but the live traveller.
    const hers = await makeSimulatedUser(portugal.persona).reply('Which airport are you flying out of?')
    expect(hers).toBe('we fly out of berlin.')
    const theirs = await makeSimulatedUser(algarve.persona).reply('Which airport are you flying out of?')
    expect(theirs).toBe('We fly out of Berlin.')
  })

  it('answers what was asked and never recites the rest of her persona', async () => {
    // The whole persona is eleven facts. A question about two of them gets two
    // clauses, which is the difference between a person typing and a notebook
    // being read back at the desk.
    const her = await makeSimulatedUser(portugal.persona)
      .reply('How many nights, and where are you flying from?')
    expect(her).toBe('we fly out of berlin and 7 nights.')
    expect(her).not.toContain('crib')
    expect(her).not.toContain('budget')
  })

  it('answers at most three clauses, however many questions arrive at once', async () => {
    const her = await makeSimulatedUser(portugal.persona)
      .reply('Where from, where to, which month, how many nights, what budget, and a crib?')
    expect(her.split(/,| and /)).toHaveLength(3)
  })

  it('invents nothing when the question is not one her facts cover', async () => {
    const her = await makeSimulatedUser(portugal.persona).reply('Would you like a sea view or a garden view?')
    expect(her).toBe("i don't mind, whatever you think is best.")
  })

  it('refuses on the phrasing a desk actually uses, not on an exact string', async () => {
    // The cue list is the fix for a refusal that fired zero times across three
    // recorded conversations: a desk does not write "a higher budget", it writes
    // "would you stretch your budget".
    const user = makeSimulatedUser(algarve.persona)
    expect(await user.reply('Everything I can find comes to more than that. Would you stretch your budget?'))
      .toBe('No, a higher budget is out and that is not something i will change.')
  })

  it('refuses rather than answering when one message carries both', async () => {
    // "How many nights, and would you take a shorter trip?" mentions `nights`,
    // which she knows, and a refusal, which wins.
    const user = makeSimulatedUser(algarve.persona)
    expect(await user.reply('How many nights, and would you consider a shorter trip?'))
      .toContain('a shorter trip is out')
  })

  it('counts her turns, so a case can stop before it loops forever', async () => {
    const user = makeSimulatedUser(portugal.persona)
    await user.reply('How long?')
    await user.reply('From where?')
    expect(user.turns).toBe(2)
  })

  it('records what she refused, in order, and nothing she merely answered', async () => {
    // `runCase` ends a case on this array (`saidNoTwice`, src/evals/runner.ts),
    // so what it holds decides how long a conversation runs and how long the
    // recording that replays it has to be.
    const user = makeSimulatedUser(algarve.persona)
    await user.reply('How many nights are you staying?')
    expect(user.refused).toEqual([])
    await user.reply('Would you consider a shorter stay?')
    await user.reply('Could you stretch your budget?')
    await user.reply('And a shorter trip?')
    expect(user.refused).toEqual(['a shorter trip', 'a higher budget', 'a shorter trip'])
  })
})

describe('the rule that ends a case going in circles', () => {
  it('is false until she refuses the same thing a second time', () => {
    // Once is a desk checking a constraint it may have misread. Twice is a desk
    // that has been told and is negotiating anyway, and nothing after it is new.
    expect(saidNoTwice([])).toBe(false)
    expect(saidNoTwice(['a higher budget'])).toBe(false)
    expect(saidNoTwice(['a higher budget', 'a shorter trip'])).toBe(false)
    expect(saidNoTwice(['a higher budget', 'a shorter trip', 'a higher budget'])).toBe(true)
  })

  it('cannot be tripped by a traveller who never refuses anything', () => {
    // The empty array is the LIVE traveller's `refused` for ever (SimUser), and
    // it is every scripted traveller's until a cue matches, so the rule has to
    // be inert on it rather than merely happen to be.
    expect(saidNoTwice([])).toBe(false)
    const answered = ['a higher budget', 'a shorter trip', 'a different month']
    expect(saidNoTwice(answered)).toBe(false)
  })
})
