import { z } from 'zod'

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] }

export const choiceQ = (instructions: string, criteria: Record<string, string | null>): JevQuestion => ({ type: 'choice', instructions, criteria })
export const noulQ = (instructions: string, criteria?: { true: string; false: string }): JevQuestion => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) })
export const scoreQ = (instructions: string, criteria: string[]): JevQuestion => ({ type: 'score', instructions, criteria })

export type JevRequest = { state: unknown; questions: Record<string, JevQuestion> }

const ChoiceAnswer = z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) })
const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number() })
const ScoreAnswer = z.object({ type: z.literal('score'), score: z.number(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) })
export const JevAnswer = z.discriminatedUnion('type', [ChoiceAnswer, NoulAnswer, ScoreAnswer])
export type JevAnswer = z.infer<typeof JevAnswer>
export const JevResponseSchema = z.object({ model: z.string(), answers: z.record(z.string(), JevAnswer), usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }) })
export type JevResponse = z.infer<typeof JevResponseSchema> & { latencyMs: number }

export type JevDeps = { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; retryDelayMs?: number }

export class JevError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'JevError' }
}

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** One call, one retry on 429/529, 3 s timeout. Answers are validated; an unexpected shape is a JevError(0). */
export async function askJev(deps: JevDeps, req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const body = JSON.stringify({ state: req.state, model: deps.model ?? 'jev-latest', questions: req.questions })
  const started = Date.now()
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController()
    // Fix round 1 (Minor): distinguish OUR timeout abort from the caller's own
    // `signal` aborting (both go through `ctl.signal`, since the caller's
    // abort is forwarded onto it below) — only the former becomes a JevError;
    // a caller-initiated abort still surfaces as its own AbortError.
    let timedOut = false
    const t = setTimeout(() => { timedOut = true; ctl.abort() }, deps.timeoutMs ?? 3000)
    signal?.addEventListener('abort', () => ctl.abort(), { once: true })
    try {
      let res: Response
      try {
        res = await fetchImpl(ENDPOINT, {
          method: 'POST', body, signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.apiKey}` },
        })
      } catch (err) {
        if (timedOut) throw new JevError(0, 'jev: timeout')
        throw err
      }
      if (res.status === 429 || res.status === 529) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 300)); continue }
        throw new JevError(res.status, `jev ${res.status}`)
      }
      if (!res.ok) throw new JevError(res.status, `jev ${res.status}`)
      const parsed = JevResponseSchema.safeParse(await res.json())
      if (!parsed.success) throw new JevError(0, 'jev: unexpected response shape')
      return { ...parsed.data, latencyMs: Date.now() - started }
    } finally {
      clearTimeout(t)
    }
  }
  throw new JevError(0, 'jev: unreachable')
}

/** Jev bills input only: $0.042 per million tokens = 0.042 micro-dollars per token. */
export function jevCostMicros(inputTokens: number): bigint {
  return BigInt(Math.ceil(inputTokens * 0.042))
}
