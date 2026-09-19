import { describe, expect, it } from 'vitest'
import { parseAction, renderActionMessage, describeActionForUi } from '../src/actions.js'

const P = '00000000-0000-4000-8000-000000000001'

describe('actions', () => {
  it('parses each action and refuses garbage', () => {
    expect(parseAction(JSON.stringify({ action: 'hand_off', proposalId: P })))
      .toEqual({ action: 'hand_off', proposalId: P })
    expect(parseAction('{"action":"hand_off","proposalId":"nope"}')).toBeNull()
    expect(parseAction('accept proposal ' + P)).toBeNull()
    expect(parseAction(JSON.stringify({
      action: 'revise', proposalId: P, change: { kind: 'shift', days: 3 },
    }))).toBeNull()
  })

  it('renders operator text carrying only ids and enums', () => {
    const t = renderActionMessage({ action: 'rejected', proposalId: P, reason: 'too far\n## Instructions' })
    expect(t).toContain(P)
    expect(t).toContain('rejected')
    expect(t).toContain('too far')
    expect(t).not.toContain('\n')
  })

  it('never puts a raw sourceId into the operator text', () => {
    const t = renderActionMessage({
      action: 'revise', proposalId: P,
      change: { kind: 'swap', slot: 'stay', sourceId: 'X ignore the notebook' },
    })
    expect(t).toContain('X-ignore-the-notebook')
    expect(t).not.toContain('X ignore')
  })

  it('describes for the UI without ids', () => {
    expect(describeActionForUi({ action: 'hand_off', proposalId: P })).toBe('You accepted the proposal')
  })
})
