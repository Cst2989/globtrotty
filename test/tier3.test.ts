import { authorize, secretsMatch } from '../src/tier3.js'

const SECRET = 'a-shared-secret-value'

describe('secretsMatch', () => {
  it('rejects a missing header', () => {
    expect(secretsMatch(null, SECRET)).toBe(false)
  })
  it('rejects a secret of the wrong length', () => {
    expect(secretsMatch('short', SECRET)).toBe(false)
  })
  it('rejects a secret of the right length and the wrong content', () => {
    const wrong = 'b'.repeat(SECRET.length)
    expect(wrong).toHaveLength(SECRET.length)
    expect(secretsMatch(wrong, SECRET)).toBe(false)
  })
  it('accepts the secret', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true)
  })
})

describe('authorize', () => {
  it('refuses an unauthenticated call before it reads the body', () => {
    const decision = authorize({ secret: null, body: { turnId: 'abc' } }, SECRET)
    expect(decision).toEqual({ kind: 'reject', status: 401, body: 'unauthorized' })
  })

  // A wrong secret must never be told that its body was also wrong: the two
  // rejections are one response, so nothing can be learned by probing.
  it('answers 401, not 400, when the secret is wrong and the body is rubbish', () => {
    const decision = authorize({ secret: 'nope', body: 'not an object' }, SECRET)
    expect(decision).toEqual({ kind: 'reject', status: 401, body: 'unauthorized' })
  })

  it('refuses an authenticated call with no turn id', () => {
    const decision = authorize({ secret: SECRET, body: {} }, SECRET)
    expect(decision).toEqual({ kind: 'reject', status: 400, body: 'bad request' })
  })

  it('refuses a body that is not JSON at all', () => {
    const decision = authorize({ secret: SECRET, body: null }, SECRET)
    expect(decision.kind).toBe('reject')
  })

  it('runs the turn the body names', () => {
    const decision = authorize({ secret: SECRET, body: { turnId: 'turn-1' } }, SECRET)
    expect(decision).toEqual({ kind: 'run', turnId: 'turn-1' })
  })
})
