import { describe, it, expect, vi } from 'vitest'
import { askJev, choiceQ, noulQ, JevError } from '../src/jev/client.js'
import { recordJevCall } from '../src/jev/record.js'
import { withTestDb } from './helpers/db.js'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('askJev', () => {
  it('posts state and questions with the bearer key and returns typed answers', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string)
      expect(sent.model).toBe('jev-latest')
      expect(sent.questions.party.type).toBe('choice')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
      return ok({ model: 'jev-1.13.0', answers: { party: { type: 'choice', choice: '2', confidence: 0.97, probabilities: { '1': 0.02, '2': 0.97, unstated: 0.01 } } }, usage: { input_tokens: 300, output_tokens: 20 } })
    })
    const r = await askJev({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }, {
      state: { message: 'two of us' },
      questions: { party: choiceQ('How many adults?', { '1': 'one', '2': 'two', unstated: 'not stated' }) },
    })
    // noUncheckedIndexedAccess + the discriminated union both need narrowing
    // the brief's inline snippet didn't: `answers` is a plain record, and only
    // the `choice` variant has `.choice`.
    const party = r.answers.party
    if (party?.type !== 'choice') throw new Error('expected a choice answer')
    expect(party.choice).toBe('2')
    expect(r.usage.input_tokens).toBe(300)
  })

  it('retries once on 529 then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (n++ === 0 ? new Response('overloaded', { status: 529 }) : ok({ model: 'jev-1.13.0', answers: { x: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } })))
    const r = await askJev({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 }, { state: 's', questions: { x: noulQ('Is it?') } })
    const x = r.answers.x
    if (x?.type !== 'noul') throw new Error('expected a noul answer')
    expect(x.noul).toBe(0.9)
    expect(n).toBe(2)
  })

  it('throws JevError on 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }))
    await expect(askJev({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }, { state: 's', questions: { x: noulQ('?') } })).rejects.toBeInstanceOf(JevError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('recordJevCall', () => {
  it('writes one model_calls row for seat intake and returns cost_micros = 13 for 300 input tokens', async () => {
    const USER = '00000000-0000-4000-8000-00000000d501'
    await withTestDb(async (sql) => {
      const response = {
        model: 'jev-1.13.0',
        answers: { party: { type: 'choice' as const, choice: '2', confidence: 0.97, probabilities: { '1': 0.02, '2': 0.97, unstated: 0.01 } } },
        usage: { input_tokens: 300, output_tokens: 20 },
        latencyMs: 42,
      }
      const request = {
        state: { message: 'two of us' },
        questions: { party: choiceQ('How many adults?', { '1': 'one', '2': 'two', unstated: 'not stated' }) },
      }
      const cost = await recordJevCall(sql, {
        conversationId: null, turnId: null, userId: USER, seat: 'intake', request, response,
      })
      expect(cost).toBe(13n)
      const [row] = await sql`select cost_micros, seat from model_calls where user_id = ${USER} and seat = 'intake'`
      expect(row!.cost_micros).toBe('13')
      expect(row!.seat).toBe('intake')
    })
  })
})
