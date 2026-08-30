import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESK_TOOLS, loadDesk, renderPrompt, toolsFor } from '../src/desks.js'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Every file that drives a desk, found rather than listed: it calls `turn()`
 * and hands it a runner, which is what makes it a path a reader can run. A
 * third driver added tomorrow is found by the same walk.
 */
function drivers(): string[] {
  return ['scripts', 'netlify/functions'].flatMap((dir) =>
    readdirSync(path.join(REPO_ROOT, dir))
      .map((name) => `${dir}/${name}`)
      .filter((file) => /\.(ts|mts|cts)$/.test(file))
      .filter((file) => /\bturn\(/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8'))),
  ).sort()
}

describe('desks', () => {
  it('gives the front desk no tools at all, gates included', () => {
    expect(toolsFor(loadDesk('front'))).toEqual([])
    expect(DESK_TOOLS.front).toEqual([])
  })
  it('lets the planning desk search and propose, and nothing else', () => {
    expect(toolsFor(loadDesk('planning')).map((t) => t.name))
      .toEqual(['search_flights', 'search_hotels', 'propose_itinerary', 'hand_off_to_booking'])
  })
  it('seats the front desk on Haiku and the planning desk on Opus', () => {
    expect(loadDesk('front').seat.model).toBe('claude-haiku-4-5-20251001')
    expect(loadDesk('planning').seat.model).toBe('claude-opus-5')
  })
  it('versions a prompt by its content', () => {
    const desk = loadDesk('planning')
    expect(desk.promptVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(loadDesk('front').promptVersion).not.toBe(desk.promptVersion)
  })
  it('refuses to render a prompt with an unfilled slot', () => {
    expect(() => renderPrompt(loadDesk('planning'), { today: '2026-08-29' })).toThrow(/requirements/)
  })

  /**
   * The tool list above is what BOTH drivers send, because both call `turn()`,
   * which builds its tools from the desk (src/conversation.ts). So a driver
   * whose runner chain has no `proposalRunner` in it advertises
   * `propose_itinerary` to the model, is asked for it, and answers "Unknown
   * tool propose_itinerary" from `supplierRunner`, the innermost link. No gate
   * runs, no `course.gate_results` row is written, and the model goes back to
   * quoting prices in prose, which is the failure this module exists to remove.
   *
   * That is what `npm run trip` did until this fix, while tier 3 was wired, so
   * the one command the README points a reader at was the one that could not
   * propose. It is a source check and not a behavioural one on purpose: the
   * chain is composed inside a script whose first statement opens a database
   * connection and calls a live model, so there is nothing here to call without
   * a key, and the habit is what the guard has to be able to see.
   *
   * One wrapper per tool this desk publishes beyond the two searches, which is
   * why the pairs below are derived from `DESK_TOOLS.planning` rather than
   * listed twice: lesson 4.6 added `hand_off_to_booking` to that list and a
   * guard that still only looked for `proposalRunner` would have watched the
   * new tool go out unanswered, which is the exact regression this case exists
   * to make impossible. Module 5.2 rebuilds the registry inside the harness; a
   * chain that loses a wrapper there fails here first.
   */
  it('wires a runner for every tool the planning desk sends into every driver', () => {
    const wrappers: Record<string, string> = {
      propose_itinerary: 'proposalRunner',
      hand_off_to_booking: 'cashierRunner',
    }
    // Derived, so a tool added to the desk with no wrapper named here fails
    // this line rather than passing unnoticed.
    const needed = DESK_TOOLS.planning
      .filter((tool) => !tool.startsWith('search_'))
      .map((tool) => wrappers[tool] ?? `NO WRAPPER NAMED FOR ${tool}`)
    expect(needed).toEqual(['proposalRunner', 'cashierRunner'])
    expect(drivers()).toEqual(['netlify/functions/run-turn-background.mts', 'scripts/trip.ts'])
    for (const file of drivers()) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const wrapper of needed) {
        expect(source, `${file} sends a tool ${wrapper} answers and does not wrap it`)
          .toMatch(new RegExp(`${wrapper}\\(`))
      }
    }
  })
})
