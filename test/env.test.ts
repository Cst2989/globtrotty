import { describe, it, expect } from 'vitest'
import { loadEnv, EnvError } from '../src/env.js'

const complete = {
  DATABASE_URL: 'postgres://localhost/globetrotty',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  WORKER_SHARED_SECRET: 'shh',
  ANTHROPIC_API_KEY: 'sk-ant-test',
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
    expect(() => loadEnv({ ...complete, WORKER_SHARED_SECRET: '' })).toThrow(EnvError)
  })
})
