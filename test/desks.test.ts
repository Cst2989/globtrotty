import { DESK_TOOLS, loadDesk, renderPrompt, toolsFor } from '../src/desks.js'

describe('desks', () => {
  it('gives the front desk no tools at all, gates included', () => {
    expect(toolsFor(loadDesk('front'))).toEqual([])
    expect(DESK_TOOLS.front).toEqual([])
  })
  it('lets the planning desk search and propose, and nothing else', () => {
    expect(toolsFor(loadDesk('planning')).map((t) => t.name))
      .toEqual(['search_flights', 'search_hotels', 'propose_itinerary'])
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
})
