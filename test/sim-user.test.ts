import { loadGoldenCases } from '../src/evals/cases.js'
import { makeSimulatedUser } from '../src/evals/sim-user.js'

const portugal = loadGoldenCases().find((c) => c.id === 'portugal-toddler-01')!
const august = loadGoldenCases().find((c) => c.id === 'no-for-1500-03')!

describe('the scripted traveller', () => {
  it('answers a question from the facts she was given', async () => {
    const her = await makeSimulatedUser(portugal.persona).reply('How many nights are you staying?')
    expect(her).toContain('nights: 7')
  })

  it('gives the same answer twice, which is the whole point', async () => {
    const one = await makeSimulatedUser(portugal.persona).reply('And what is your budget?')
    const two = await makeSimulatedUser(portugal.persona).reply('And what is your budget?')
    expect(one).toBe(two)
    expect(one).toContain('1500')
  })

  it('invents nothing when the question is not one her facts cover', async () => {
    const her = await makeSimulatedUser(portugal.persona).reply('Would you like a sea view or a garden view?')
    expect(her).toBe("I don't mind, whatever you think is best.")
  })

  it('refuses what the persona refuses, however it is put to her', async () => {
    const user = makeSimulatedUser(august.persona)
    expect(await user.reply('Would you consider a different month, say late September?'))
      .toContain('No a different month')
  })

  it('refuses rather than answering when one question carries both', async () => {
    // "How many nights, and would you go to a higher budget?" mentions `nights`,
    // which she knows, and a refusal, which wins.
    const user = makeSimulatedUser(august.persona)
    expect(await user.reply('How many nights, and would you consider a higher budget?'))
      .toContain('No a higher budget')
  })

  it('counts her turns, so a case can stop before it loops forever', async () => {
    const user = makeSimulatedUser(portugal.persona)
    await user.reply('How long?')
    await user.reply('From where?')
    expect(user.turns).toBe(2)
  })
})
