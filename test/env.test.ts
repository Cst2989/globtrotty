import { loadEnv, EnvError } from '../src/env.js'

const complete = {
  DATABASE_URL: 'postgres://localhost/globetrotty',
  ANTHROPIC_API_KEY: 'sk-ant-test',
}

describe('loadEnv', () => {
  it('returns a typed env when everything is present', () => {
    expect(loadEnv(complete).DATABASE_URL).toBe('postgres://localhost/globetrotty')
  })

  it('reports every missing key at once, not just the first', () => {
    try {
      loadEnv({})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError)
      expect((e as EnvError).missing.sort()).toEqual(['ANTHROPIC_API_KEY', 'DATABASE_URL'])
    }
  })

  it('treats an empty string as missing', () => {
    expect(() => loadEnv({ ...complete, ANTHROPIC_API_KEY: '' })).toThrow(EnvError)
  })
})
