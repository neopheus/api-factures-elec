import type { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../src/auth/session.service.js'
import { hashToken } from '../../src/auth/session-token.js'
import type { EnvConfig } from '../../src/config/env.js'

function fakeConfig(ttlHours = 12): ConfigService<EnvConfig, true> {
  return {
    get: (key: keyof EnvConfig) =>
      key === 'SESSION_TTL_HOURS' ? ttlHours : undefined,
  } as unknown as ConfigService<EnvConfig, true>
}

describe('SessionService', () => {
  let query: ReturnType<typeof vi.fn>
  let service: SessionService

  beforeEach(() => {
    query = vi.fn()
    service = new SessionService(
      { query } as unknown as pg.Pool,
      fakeConfig(12),
    )
  })

  it('ttlMs() converts SESSION_TTL_HOURS to milliseconds', () => {
    expect(service.ttlMs()).toBe(12 * 3_600_000)
  })

  it('create() persists hashed tokens via create_session and returns opaque token + csrf + expiry', async () => {
    query.mockResolvedValue({ rows: [] })

    const before = Date.now()
    const issued = await service.create({ userId: 'u1', tenantId: 't1' })
    const after = Date.now()

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('create_session')
    expect(params[0]).toBe('u1')
    expect(params[1]).toBeNull() // adminId absent → null
    expect(params[2]).toBe('t1')
    expect(params[3]).toBe(hashToken(issued.token))
    expect(params[4]).toBe(hashToken(issued.csrfToken))
    expect(issued.token).not.toBe(issued.csrfToken)
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + service.ttlMs(),
    )
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(
      after + service.ttlMs(),
    )
  })

  it('create() defaults absent userId/adminId/tenantId to null (admin session example)', async () => {
    query.mockResolvedValue({ rows: [] })

    await service.create({ adminId: 'admin-1' })

    const params = query.mock.calls[0]![1]
    expect(params).toEqual([
      null,
      'admin-1',
      null,
      expect.any(String),
      expect.any(String),
      expect.any(Date),
    ])
  })

  it('find() returns null when find_session has no row (unknown token)', async () => {
    query.mockResolvedValue({ rows: [] })

    expect(await service.find('unknown')).toBeNull()
    expect(query.mock.calls[0]![1]).toEqual([hashToken('unknown')])
  })

  it('find() returns the subject when the session is not expired', async () => {
    query.mockResolvedValue({
      rows: [
        {
          session_id: 's1',
          user_id: 'u1',
          admin_id: null,
          tenant_id: 't1',
          role: 'owner',
          csrf_hash: 'hash',
          expires_at: new Date(Date.now() + 3_600_000),
        },
      ],
    })

    expect(await service.find('tok')).toEqual({
      sessionId: 's1',
      userId: 'u1',
      adminId: null,
      tenantId: 't1',
      role: 'owner',
      csrfHash: 'hash',
    })
  })

  it('find() rejects (returns null) an expired session — expiry enforced app-side, never renewed', async () => {
    query.mockResolvedValue({
      rows: [
        {
          session_id: 's1',
          user_id: 'u1',
          admin_id: null,
          tenant_id: 't1',
          role: 'owner',
          csrf_hash: 'hash',
          expires_at: new Date(Date.now() - 1000),
        },
      ],
    })

    expect(await service.find('tok')).toBeNull()
    // Aucune requête de mise à jour (renouvellement glissant) : un seul appel SQL.
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('revoke() calls revoke_session with the hashed token', async () => {
    query.mockResolvedValue({ rows: [] })

    await service.revoke('tok')

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('revoke_session')
    expect(params).toEqual([hashToken('tok')])
  })
})
