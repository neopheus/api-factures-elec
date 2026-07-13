import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock du module api-key.ts : verrouille que ApiKeyService.authenticate()
// n'appelle JAMAIS verifySecret sur le chemin "préfixe inconnu/révoqué" (et
// inversement, jamais timingSafeReject sur le chemin "préfixe connu") — c'est
// exactement le mécanisme anti-oracle temporel (un seul appel argon2id verify
// par tentative, quel que soit le cas). Les autres comportements (parse réel,
// hash réel) sont verrouillés séparément par tests/unit/api-key.test.ts et par
// l'e2e (Postgres réel, SECURITY DEFINER).
vi.mock('../../src/auth/api-key.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/auth/api-key.js')>()
  return {
    ...actual,
    parseApiKeyToken: vi.fn(),
    verifySecret: vi.fn(),
    timingSafeReject: vi.fn().mockResolvedValue(undefined),
  }
})

const { parseApiKeyToken, verifySecret, timingSafeReject } = await import(
  '../../src/auth/api-key.js'
)
const { ApiKeyService } = await import('../../src/auth/api-key.service.js')

function fakePool(queryResult: { rows: unknown[] }) {
  const query = vi.fn().mockResolvedValue(queryResult)
  return { pool: { query } as unknown as pg.Pool, query }
}

describe('ApiKeyService.authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null immediately for a malformed token — no DB query, no timing equalizer', async () => {
    vi.mocked(parseApiKeyToken).mockReturnValue(null)
    const { pool, query } = fakePool({ rows: [] })
    const service = new ApiKeyService(pool)

    const result = await service.authenticate('garbage')

    expect(result).toBeNull()
    expect(query).not.toHaveBeenCalled()
    expect(timingSafeReject).not.toHaveBeenCalled()
  })

  it('looks up ONLY the prefix (never the secret) and rejects an unknown prefix via the timing equalizer', async () => {
    vi.mocked(parseApiKeyToken).mockReturnValue({
      prefix: 'unknownpfx',
      secret: 'topsecret',
    })
    const { pool, query } = fakePool({ rows: [] })
    const service = new ApiKeyService(pool)

    const result = await service.authenticate('fk_unknownpfx.topsecret')

    expect(result).toBeNull()
    expect(query).toHaveBeenCalledWith(
      'SELECT api_key_id, tenant_id, secret_hash, revoked_at FROM authenticate_api_key($1)',
      ['unknownpfx'],
    )
    expect(JSON.stringify(query.mock.calls)).not.toContain('topsecret')
    expect(timingSafeReject).toHaveBeenCalledWith('topsecret')
    expect(verifySecret).not.toHaveBeenCalled()
  })

  it('rejects a revoked key via the timing equalizer — no distinction from an unknown prefix', async () => {
    vi.mocked(parseApiKeyToken).mockReturnValue({
      prefix: 'revokedpfx',
      secret: 's',
    })
    const { pool } = fakePool({
      rows: [
        {
          api_key_id: 'k1',
          tenant_id: 't1',
          secret_hash: 'h',
          revoked_at: new Date(),
        },
      ],
    })
    const service = new ApiKeyService(pool)

    const result = await service.authenticate('fk_revokedpfx.s')

    expect(result).toBeNull()
    expect(timingSafeReject).toHaveBeenCalledWith('s')
    expect(verifySecret).not.toHaveBeenCalled()
  })

  it('rejects a known, active prefix with a bad secret (real argon2 verify call, not the equalizer)', async () => {
    vi.mocked(parseApiKeyToken).mockReturnValue({
      prefix: 'okpfx',
      secret: 'bad',
    })
    vi.mocked(verifySecret).mockResolvedValue(false)
    const { pool } = fakePool({
      rows: [
        {
          api_key_id: 'k1',
          tenant_id: 't1',
          secret_hash: '$argon2id$fake',
          revoked_at: null,
        },
      ],
    })
    const service = new ApiKeyService(pool)

    const result = await service.authenticate('fk_okpfx.bad')

    expect(result).toBeNull()
    expect(verifySecret).toHaveBeenCalledWith('$argon2id$fake', 'bad')
    expect(timingSafeReject).not.toHaveBeenCalled()
  })

  it('authenticates a valid, active key and returns { apiKeyId, tenantId }', async () => {
    vi.mocked(parseApiKeyToken).mockReturnValue({
      prefix: 'okpfx',
      secret: 'good',
    })
    vi.mocked(verifySecret).mockResolvedValue(true)
    const { pool } = fakePool({
      rows: [
        {
          api_key_id: 'k1',
          tenant_id: 't1',
          secret_hash: '$argon2id$fake',
          revoked_at: null,
        },
      ],
    })
    const service = new ApiKeyService(pool)

    const result = await service.authenticate('fk_okpfx.good')

    expect(result).toEqual({ apiKeyId: 'k1', tenantId: 't1' })
  })
})
