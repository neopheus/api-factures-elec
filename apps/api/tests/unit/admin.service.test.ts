import { UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminService } from '../../src/admin/admin.service.js'
import * as passwordModule from '../../src/auth/password.js'

describe('AdminService', () => {
  let query: ReturnType<typeof vi.fn>
  let service: AdminService

  beforeEach(() => {
    query = vi.fn()
    service = new AdminService({ query } as unknown as pg.Pool)
  })

  describe('login', () => {
    it('returns the admin identity on valid credentials', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValue({
        rows: [{ admin_id: 'a1', password_hash: hash }],
      })

      const result = await service.login(
        'root@factelec.fr',
        'super-admin-passphrase-1',
      )

      expect(result).toEqual({ adminId: 'a1' })
      const [sql, params] = query.mock.calls[0]!
      expect(sql).toContain('authenticate_platform_admin')
      expect(params[0]).toBe('root@factelec.fr')
    })

    it('rejects an unknown email with 401 and runs the timing-safe dummy verify (anti-enumeration)', async () => {
      query.mockResolvedValue({ rows: [] })
      const spy = vi.spyOn(passwordModule, 'timingSafeVerifyReject')

      await expect(
        service.login('ghost@factelec.fr', 'whatever-guess'),
      ).rejects.toBeInstanceOf(UnauthorizedException)
      expect(spy).toHaveBeenCalledWith('whatever-guess')
    })

    it('rejects a wrong password with the identical 401 problem body as an unknown email', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [{ admin_id: 'a1', password_hash: hash }],
      })
      const wrongPasswordError = await service
        .login('root@factelec.fr', 'wrong-password')
        .catch((e) => e)

      query.mockResolvedValueOnce({ rows: [] })
      const unknownEmailError = await service
        .login('ghost@factelec.fr', 'super-admin-passphrase-1')
        .catch((e) => e)

      expect(wrongPasswordError).toBeInstanceOf(UnauthorizedException)
      expect(wrongPasswordError.getResponse()).toEqual(
        unknownEmailError.getResponse(),
      )
    })
  })

  describe('listTenants', () => {
    it('maps every tenant row, converting bigint counts to numbers', async () => {
      query.mockResolvedValue({
        rows: [
          {
            id: 't1',
            name: 'Shop A',
            siren: null,
            created_at: new Date('2024-01-01T00:00:00Z'),
            user_count: '3',
            invoice_count: '10',
          },
          {
            id: 't2',
            name: 'Shop B',
            siren: '732829320',
            created_at: new Date('2024-02-01T00:00:00Z'),
            user_count: '0',
            invoice_count: '0',
          },
        ],
      })

      const result = await service.listTenants()

      expect(result).toEqual([
        {
          id: 't1',
          name: 'Shop A',
          siren: null,
          createdAt: new Date('2024-01-01T00:00:00Z'),
          userCount: 3,
          invoiceCount: 10,
        },
        {
          id: 't2',
          name: 'Shop B',
          siren: '732829320',
          createdAt: new Date('2024-02-01T00:00:00Z'),
          userCount: 0,
          invoiceCount: 0,
        },
      ])
      const [sql] = query.mock.calls[0]!
      expect(sql).toContain('list_tenants_for_admin')
    })
  })
})
