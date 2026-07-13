import { describe, expect, it } from 'vitest'
import { validateEnv } from '../../src/config/env.js'

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://factelec_app:pw@localhost:5432/factelec',
  CORS_ALLOWED_ORIGINS: 'http://a.example,http://b.example',
  RATE_LIMIT_TTL: '60',
  RATE_LIMIT_LIMIT: '120',
}

describe('validateEnv', () => {
  it('parses and coerces a valid environment', () => {
    const env = validateEnv(base)
    expect(env.PORT).toBe(3000)
    expect(env.RATE_LIMIT_LIMIT).toBe(120)
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([
      'http://a.example',
      'http://b.example',
    ])
  })

  it('applies safe defaults for optional keys', () => {
    const env = validateEnv({ DATABASE_URL: base.DATABASE_URL })
    expect(env.PORT).toBe(3000)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([])
  })

  it('throws listing offending KEYS only (never values — no secret leak)', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrowError(/DATABASE_URL/)
    // le message ne doit contenir aucune valeur d'environnement
    try {
      validateEnv({ DATABASE_URL: 'not-a-url', SECRET: 'p@ssw0rd' })
    } catch (e) {
      expect((e as Error).message).not.toContain('p@ssw0rd')
      expect((e as Error).message).toContain('DATABASE_URL')
    }
  })

  it('defaults TRUST_PROXY to 0 (direct connection, current behavior) when unset', () => {
    const env = validateEnv(base)
    expect(env.TRUST_PROXY).toBe(0)
  })

  it.each([
    '0',
    '2',
  ])('accepts a non-negative integer TRUST_PROXY (%s)', (v) => {
    const env = validateEnv({ ...base, TRUST_PROXY: v })
    expect(env.TRUST_PROXY).toBe(Number(v))
  })

  it.each(['-1', '1.5', 'abc'])('rejects an invalid TRUST_PROXY (%s)', (v) => {
    expect(() => validateEnv({ ...base, TRUST_PROXY: v })).toThrowError(
      /TRUST_PROXY/,
    )
  })

  it('falls back to the (root) marker when a zod issue carries no field path', () => {
    // Un input qui n'est pas un objet (ex: null) produit une issue racine
    // (path: []) plutôt qu'une issue liée à une clé précise.
    expect(() =>
      validateEnv(null as unknown as Record<string, unknown>),
    ).toThrowError(/\(root\)/)
  })
})
