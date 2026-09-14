import { readFileSync } from 'node:fs'
import { CADENCE, renderCadence } from '../src/loop/cadence.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
  { scripts: Record<string, string> }

describe('the cadence', () => {
  it('names a real command wherever it names one at all', () => {
    // The check that keeps this table from becoming a wish list: a rhythm whose
    // command does not exist is a rhythm nobody can run, and it would read
    // exactly like one that works.
    for (const entry of CADENCE) {
      if (entry.command !== null) expect(Object.keys(pkg.scripts)).toContain(entry.command)
    }
  })

  it('says what a person does on every row, including the ones with a command', () => {
    for (const entry of CADENCE) expect(entry.whatAPersonDoes.length).toBeGreaterThan(20)
  })

  it('covers the product and the people building it', () => {
    expect(new Set(CADENCE.map((e) => e.who))).toEqual(
      new Set(['the agency', 'the people building it']))
    expect(renderCadence(CADENCE)).toContain('npm run worst')
  })
})
