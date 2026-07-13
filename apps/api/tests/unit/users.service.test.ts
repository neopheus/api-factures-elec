import { ConflictException, UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as passwordModule from '../../src/auth/password.js'
import type { TenantContextService } from '../../src/db/tenant-context.service.js'
import { UsersService } from '../../src/users/users.service.js'

describe('UsersService', () => {
  let query: ReturnType<typeof vi.fn>
  let tenantRun: ReturnType<typeof vi.fn>
  let service: UsersService

  beforeEach(() => {
    query = vi.fn()
    tenantRun = vi.fn()
    service = new UsersService(
      { query } as unknown as pg.Pool,
      { run: tenantRun } as unknown as TenantContextService,
    )
  })

  describe('signup', () => {
    it('hashes the password and creates the tenant + owner user via signup_tenant', async () => {
      query.mockResolvedValue({ rows: [{ user_id: 'u1', tenant_id: 't1' }] })

      const result = await service.signup({
        email: 'a@b.com',
        password: 'a-strong-passphrase-123',
        organizationName: 'Shop',
        siren: null,
      })

      expect(result).toEqual({ userId: 'u1', tenantId: 't1', role: 'owner' })
      const [sql, params] = query.mock.calls[0]!
      expect(sql).toContain('signup_tenant')
      expect(params[0]).toBe('a@b.com')
      expect(params[1]).toMatch(/^\$argon2id\$/) // jamais le mot de passe en clair
      expect(params[2]).toBe('Shop')
      expect(params[3]).toBeNull()
    })

    it('translates a unique-violation (23505) into a 409 Conflict without leaking which field conflicted', async () => {
      query.mockRejectedValue({ code: '23505' })

      await expect(
        service.signup({
          email: 'dup@b.com',
          password: 'a-strong-passphrase-123',
          organizationName: 'Shop',
          siren: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException)
    })

    it('rethrows any other database error unchanged', async () => {
      const boom = new Error('connection lost')
      query.mockRejectedValue(boom)

      await expect(
        service.signup({
          email: 'a@b.com',
          password: 'a-strong-passphrase-123',
          organizationName: 'Shop',
          siren: null,
        }),
      ).rejects.toBe(boom)
    })
  })

  describe('login', () => {
    it('returns the user identity on valid credentials', async () => {
      const hash = await passwordModule.hashPassword('a-strong-passphrase-123')
      query.mockResolvedValue({
        rows: [
          {
            user_id: 'u1',
            tenant_id: 't1',
            role: 'owner',
            password_hash: hash,
          },
        ],
      })

      const result = await service.login('a@b.com', 'a-strong-passphrase-123')

      expect(result).toEqual({ userId: 'u1', tenantId: 't1', role: 'owner' })
    })

    it('rejects an unknown email with 401 and runs the timing-safe dummy verify (anti-enumeration)', async () => {
      query.mockResolvedValue({ rows: [] })
      const spy = vi.spyOn(passwordModule, 'timingSafeVerifyReject')

      await expect(
        service.login('ghost@b.com', 'whatever-guess'),
      ).rejects.toBeInstanceOf(UnauthorizedException)
      expect(spy).toHaveBeenCalledWith('whatever-guess')
    })

    it('rejects a wrong password with the identical 401 problem body as an unknown email', async () => {
      const hash = await passwordModule.hashPassword('a-strong-passphrase-123')
      query.mockResolvedValueOnce({
        rows: [
          {
            user_id: 'u1',
            tenant_id: 't1',
            role: 'owner',
            password_hash: hash,
          },
        ],
      })
      const wrongPasswordError = await service
        .login('a@b.com', 'wrong-password')
        .catch((e) => e)

      query.mockResolvedValueOnce({ rows: [] })
      const unknownEmailError = await service
        .login('ghost@b.com', 'a-strong-passphrase-123')
        .catch((e) => e)

      expect(wrongPasswordError).toBeInstanceOf(UnauthorizedException)
      expect(wrongPasswordError.getResponse()).toEqual(
        unknownEmailError.getResponse(),
      )
    })
  })

  describe('me', () => {
    it('runs the profile lookup within the user tenant context (RLS-scoped)', async () => {
      const profile = {
        id: 'u1',
        email: 'a@b.com',
        role: 'owner',
        tenantId: 't1',
        emailVerified: false,
      }
      const limit = vi.fn().mockResolvedValue([profile])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      const select = vi.fn().mockReturnValue({ from })
      const db = { select }
      tenantRun.mockImplementation(
        (_tenantId: string, work: (db: unknown) => Promise<unknown>) =>
          work(db),
      )

      const result = await service.me({ userId: 'u1', tenantId: 't1' })

      expect(tenantRun).toHaveBeenCalledWith('t1', expect.any(Function))
      expect(result).toEqual(profile)
    })
  })
})
