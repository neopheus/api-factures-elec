import { UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminService } from '../../src/admin/admin.service.js'
import type {
  AdminSupervisionRepository,
  AdminTenantDetail,
  AdminTenantStats,
} from '../../src/admin/admin-supervision.repository.js'
import * as passwordModule from '../../src/auth/password.js'

describe('AdminService', () => {
  let query: ReturnType<typeof vi.fn>
  let supervision: {
    tenantStats: ReturnType<typeof vi.fn>
    tenantDetail: ReturnType<typeof vi.fn>
    suspend: ReturnType<typeof vi.fn>
    unsuspend: ReturnType<typeof vi.fn>
  }
  let service: AdminService

  beforeEach(() => {
    query = vi.fn()
    supervision = {
      tenantStats: vi.fn(),
      tenantDetail: vi.fn(),
      suspend: vi.fn(),
      unsuspend: vi.fn(),
    }
    service = new AdminService(
      { query } as unknown as pg.Pool,
      supervision as unknown as AdminSupervisionRepository,
    )
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

  // Vecteur modifié (Task 3, spec §3) : `listTenants` ne construit plus la
  // requête SQL/le mapping bigint→number lui-même (ancien test ci-dessus,
  // supprimé) — cette logique a migré dans `AdminSupervisionRepository`
  // (SD 1 find_admin_tenant_stats), couverte par
  // `tests/e2e/admin-supervision.e2e.test.ts` contre un vrai Postgres (même
  // convention que BillingRepository, jamais unit-testé avec un pool mocké).
  // `AdminService.listTenants` est désormais un pur délégateur : le seul
  // comportement à vérifier ici est la délégation elle-même.
  describe('listTenants', () => {
    it('delegates to AdminSupervisionRepository.tenantStats and forwards its result unchanged', async () => {
      const stats: AdminTenantStats[] = [
        {
          id: 't1',
          name: 'Shop A',
          siren: null,
          createdAt: new Date('2024-01-01T00:00:00Z'),
          suspendedAt: null,
          billingStatus: 'active',
          invoices30d: 3,
          ereporting30d: 1,
          deadLetters: 0,
        },
      ]
      supervision.tenantStats.mockResolvedValue(stats)

      const result = await service.listTenants()

      expect(supervision.tenantStats).toHaveBeenCalledWith()
      expect(result).toBe(stats)
    })
  })

  describe('tenantDetail', () => {
    it('delegates to AdminSupervisionRepository.tenantDetail with the given id', async () => {
      const detail: AdminTenantDetail = {
        id: 't1',
        name: 'Shop A',
        siren: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        suspendedAt: null,
        billingStatus: 'active',
        invoices30d: 3,
        ereporting30d: 1,
        deadLetters: 0,
        invoices: [],
        billing: {
          status: 'active',
          currentPeriodEnd: null,
          hasCustomer: true,
        },
      }
      supervision.tenantDetail.mockResolvedValue(detail)

      const result = await service.tenantDetail('t1')

      expect(supervision.tenantDetail).toHaveBeenCalledWith('t1')
      expect(result).toBe(detail)
    })

    it('forwards null unchanged when the repository finds no matching tenant (controller turns it into 404)', async () => {
      supervision.tenantDetail.mockResolvedValue(null)

      const result = await service.tenantDetail('unknown-id')

      expect(result).toBeNull()
    })
  })

  // Task 4 (spec §3) : purs délégateurs (même motif que listTenants/
  // tenantDetail ci-dessus) — le mapping HTTP (404/409) vit dans
  // AdminController, la logique SQL/transaction dans le repository.
  describe('suspendTenant', () => {
    it('delegates to AdminSupervisionRepository.suspend and forwards its outcome unchanged', async () => {
      const outcome = { outcome: 'suspended' as const, suspendedAt: new Date() }
      supervision.suspend.mockResolvedValue(outcome)

      const result = await service.suspendTenant('t1', 'a1', 'abus signalé')

      expect(supervision.suspend).toHaveBeenCalledWith(
        't1',
        'a1',
        'abus signalé',
      )
      expect(result).toBe(outcome)
    })
  })

  describe('unsuspendTenant', () => {
    it('delegates to AdminSupervisionRepository.unsuspend and forwards its outcome unchanged', async () => {
      const outcome = { outcome: 'unsuspended' as const }
      supervision.unsuspend.mockResolvedValue(outcome)

      const result = await service.unsuspendTenant('t1', 'a1')

      expect(supervision.unsuspend).toHaveBeenCalledWith('t1', 'a1')
      expect(result).toBe(outcome)
    })
  })
})
