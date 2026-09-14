import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
  { scripts: Record<string, string> }

describe('who runs the loop, at lesson-7-5', () => {
  it('has a command for every machine except the ones this module built', () => {
    // Six modules of machinery reachable from one file, and then the loop.
    expect(Object.keys(pkg.scripts)).toContain('evals')
    expect(Object.keys(pkg.scripts)).toContain('demo')
    expect(Object.keys(pkg.scripts)).toContain('sentinels')
    // The monthly refresh got one at lesson 7.4.
    expect(Object.keys(pkg.scripts)).toContain('examples')
    // The weekly read has none, which means the weekly read does not happen.
    expect(Object.keys(pkg.scripts)).not.toContain('worst')
  })

  it('has nothing anywhere that says how often any of it runs', () => {
    // A machine with no rhythm is a machine that ran once, on the day somebody
    // built it, in the terminal of the person who built it.
    expect(Object.keys(pkg.scripts).filter((s) => /weekly|monthly|quarterly/.test(s))).toEqual([])
  })
})
