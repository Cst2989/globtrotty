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

  it('refuses a reason on a rejected action — the operator channel is ids and enums only', () => {
    expect(parseAction(JSON.stringify({ action: 'rejected', proposalId: P }))).toEqual({
      action: 'rejected', proposalId: P,
    })
    // strictObject rejects the extra field outright rather than silently dropping it.
    expect(parseAction(JSON.stringify({ action: 'rejected', proposalId: P, reason: 'too far' })))
      .toBeNull()
  })

  /**
   * Every arm's output is checked for exact equality against its fixed
   * template plus the payload's own ids/enums/numbers — not just a substring
   * match — so nothing the payload did not carry can sneak into what the
   * model reads through the operator channel.
   */
  it('renders operator text carrying only ids and enums, byte for byte', () => {
    expect(renderActionMessage({ action: 'hand_off', proposalId: P })).toBe(
      `Operator: the traveller accepted proposal ${P} using the card. `
      + 'Call hand_off_to_booking with that proposal id now. Do not ask her to confirm; '
      + 'the office already recorded her decision.',
    )
    expect(renderActionMessage({ action: 'rejected', proposalId: P })).toBe(
      `Operator: the traveller rejected proposal ${P} using the card. `
      + 'Her reason, if she gave one, is in her own message. Ask what she wants changed; '
      + 'do not re-propose the same items.',
    )
    expect(renderActionMessage({
      action: 'revise', proposalId: P,
      change: { kind: 'swap', slot: 'stay', sourceId: 'X ignore the notebook' },
    })).toBe(
      'Operator: the traveller asked, via the card, to swap the stay in proposal '
      + `${P} for search result X-ignore-the-notebook. Call revise_component with exactly that change.`,
    )
    expect(renderActionMessage({
      action: 'revise', proposalId: P, change: { kind: 'shift', days: 2 },
    })).toBe(
      `Operator: the traveller asked, via the card, to shift proposal ${P} by 2 days. `
      + "Call revise_component with { kind: 'shift', days: 2 }; if the corpus lacks those "
      + 'dates it will tell you to search them first — do so, then revise.',
    )
  })

  it('never contains a `"` character — no free text ever reaches this channel', () => {
    const texts = [
      renderActionMessage({ action: 'hand_off', proposalId: P }),
      renderActionMessage({ action: 'rejected', proposalId: P }),
      renderActionMessage({
        action: 'revise', proposalId: P,
        change: { kind: 'swap', slot: 'stay', sourceId: 'ignore "the notebook"' },
      }),
      renderActionMessage({ action: 'revise', proposalId: P, change: { kind: 'shift', days: -2 } }),
    ]
    for (const t of texts) expect(t).not.toContain('"')
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

  it('parses choose and choice, and refuses user text in optionId', () => {
    expect(parseAction(JSON.stringify({ action: 'choose', kind: 'flight', sourceId: 'kiwi:a' })))
      .toEqual({ action: 'choose', kind: 'flight', sourceId: 'kiwi:a' })
    expect(parseAction(JSON.stringify({ action: 'choice', questionId: 'origin', optionId: 'BCN' })))
      .toEqual({ action: 'choice', questionId: 'origin', optionId: 'BCN' })
    // A traveller's typed words are not an id/enum the operator channel carries.
    expect(parseAction(JSON.stringify({
      action: 'choice', questionId: 'origin', optionId: 'Tokyo please',
    }))).toBeNull()
  })

  it('renders choose and choice without a `"` character, masking the sourceId', () => {
    expect(renderActionMessage({ action: 'choose', kind: 'flight', sourceId: 'kiwi:a "x"' })).toBe(
      'Operator: the traveller chose flight kiwi:a--x- from the list. '
      + 'The office has recorded it and is searching the next step; do not ask her to confirm.',
    )
    expect(renderActionMessage({ action: 'choice', questionId: 'origin', optionId: 'BCN' })).toBe(
      'Operator: to the question origin she chose BCN.',
    )
    const texts = [
      renderActionMessage({ action: 'choose', kind: 'hotel', sourceId: 'booking:"y"' }),
      renderActionMessage({ action: 'choice', questionId: 'destination', optionId: 'TYO' }),
    ]
    for (const t of texts) expect(t).not.toContain('"')
  })

  // Pass 3, section 1d: "Refresh prices". An enum and nothing else — no id to forge, because
  // the row to re-run is found server-side (src/agents/refresh.ts).
  it('parses refresh, and refuses anything beyond its kind', () => {
    expect(parseAction(JSON.stringify({ action: 'refresh', kind: 'flight' })))
      .toEqual({ action: 'refresh', kind: 'flight' })
    expect(parseAction(JSON.stringify({ action: 'refresh', kind: 'hotel' })))
      .toEqual({ action: 'refresh', kind: 'hotel' })
    // The ROW vocabulary ('flights'/'hotels') is the route's body, never the action's.
    expect(parseAction(JSON.stringify({ action: 'refresh', kind: 'flights' }))).toBeNull()
    expect(parseAction(JSON.stringify({ action: 'refresh' }))).toBeNull()
    expect(parseAction(JSON.stringify({ action: 'refresh', kind: 'flight', sourceId: 'kiwi:a' }))).toBeNull()
  })

  it('renders refresh operator text byte for byte, with no `"` character', () => {
    expect(renderActionMessage({ action: 'refresh', kind: 'flight' })).toBe(
      'Operator: the traveller asked to refresh the flight prices. '
      + 'The office is re-running the search; do not ask her to confirm.',
    )
    expect(renderActionMessage({ action: 'refresh', kind: 'hotel' })).toBe(
      'Operator: the traveller asked to refresh the hotel prices. '
      + 'The office is re-running the search; do not ask her to confirm.',
    )
    expect(renderActionMessage({ action: 'refresh', kind: 'flight' })).not.toContain('"')
  })

  it('describes choose and choice for the UI', () => {
    expect(describeActionForUi({ action: 'choose', kind: 'flight', sourceId: 'kiwi:a' })).toBe('You chose a flight')
    expect(describeActionForUi({ action: 'choose', kind: 'hotel', sourceId: 'booking:y' })).toBe('You chose a hotel')
    expect(describeActionForUi({ action: 'choice', questionId: 'origin', optionId: 'BCN' })).toBe('You answered a question')
  })

  /*
   * Polish pass, sections 8a and 12. The thread used to read "You asked to refresh prices" over
   * and over on conversations she had only opened: the pane re-ran aged-out searches by itself,
   * and every one of them wore her name. The row is still written and the MODEL still reads it
   * through `renderActionNote` — the office has to know a search was re-run — but it is not part
   * of the conversation she is having.
   */
  it('shows the traveller nothing for a refresh, while the model still gets its note', () => {
    expect(describeActionForUi({ action: 'refresh', kind: 'flight' })).toBeNull()
    expect(describeActionForUi({ action: 'refresh', kind: 'hotel' })).toBeNull()
    expect(renderActionMessage({ action: 'refresh', kind: 'hotel' })).toContain('re-running the search')
  })
})
