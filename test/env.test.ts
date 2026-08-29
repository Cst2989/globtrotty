import { loadEnv, EnvError } from '../src/env.js'

const complete = {
  DATABASE_URL: 'postgres://localhost/globetrotty',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  WORKER_SHARED_SECRET: 'shh',
  SITE_URL: 'http://localhost:8888',
}

describe('loadEnv', () => {
  it('returns a typed env when everything is present', () => {
    expect(loadEnv(complete).DATABASE_URL).toBe('postgres://localhost/globetrotty')
  })

  it('reports every missing key at once, not just the first', () => {
    const { DATABASE_URL, SITE_URL, ...rest } = complete
    try {
      loadEnv(rest)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError)
      expect((e as EnvError).missing.sort()).toEqual(['DATABASE_URL', 'SITE_URL'])
    }
  })

  it('treats an empty string as missing', () => {
    expect(() => loadEnv({ ...complete, ANTHROPIC_API_KEY: '' })).toThrow(EnvError)
  })
})
