import { ConflictException, NotFoundException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminController } from '../../src/admin/admin.controller.js'
import type { AdminService } from '../../src/admin/admin.service.js'
import type { AdminJobsService } from '../../src/admin/admin-jobs.service.js'
import type { AdminTenantDetail } from '../../src/admin/admin-supervision.repository.js'
import type {
  AuthenticatedAdmin,
  SessionRequest,
} from '../../src/auth/auth.types.js'
import type { SessionService } from '../../src/auth/session.service.js'
import { SESSION_COOKIE } from '../../src/auth/session-token.js'
import type { EnvConfig } from '../../src/config/env.js'

const FAKE_ADMIN: AuthenticatedAdmin = {
  sessionId: 's1',
  adminId: 'a1',
  csrfHash: 'h',
}

function fakeConfig(): ConfigService<EnvConfig, true> {
  return {
    get: (key: keyof EnvConfig) => (key === 'NODE_ENV' ? 'test' : undefined),
  } as unknown as ConfigService<EnvConfig, true>
}

function fakeResponse(): Response {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response
}

describe('AdminController', () => {
  let admin: {
    login: ReturnType<typeof vi.fn>
    listTenants: ReturnType<typeof vi.fn>
    tenantDetail: ReturnType<typeof vi.fn>
    suspendTenant: ReturnType<typeof vi.fn>
    unsuspendTenant: ReturnType<typeof vi.fn>
  }
  let sessions: {
    create: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
    ttlMs: ReturnType<typeof vi.fn>
  }
  let jobs: {
    retryFailed: ReturnType<typeof vi.fn>
  }
  let controller: AdminController

  beforeEach(() => {
    admin = {
      login: vi.fn(),
      listTenants: vi.fn(),
      tenantDetail: vi.fn(),
      suspendTenant: vi.fn(),
      unsuspendTenant: vi.fn(),
    }
    sessions = {
      create: vi.fn(),
      revoke: vi.fn(),
      ttlMs: vi.fn().mockReturnValue(1000),
    }
    jobs = {
      retryFailed: vi.fn(),
    }
    controller = new AdminController(
      admin as unknown as AdminService,
      sessions as unknown as SessionService,
      fakeConfig(),
      jobs as unknown as AdminJobsService,
    )
  })

  it('login: validates the body, authenticates, issues session + csrf cookies, returns admin identity', async () => {
    admin.login.mockResolvedValue({ adminId: 'a1' })
    sessions.create.mockResolvedValue({
      token: 'tok',
      csrfToken: 'csrf',
      expiresAt: new Date(),
    })
    const res = fakeResponse()

    const result = await controller.login(
      { email: 'root@factelec.fr', password: 'super-admin-passphrase-1' },
      res,
    )

    expect(admin.login).toHaveBeenCalledWith(
      'root@factelec.fr',
      'super-admin-passphrase-1',
    )
    expect(sessions.create).toHaveBeenCalledWith({ adminId: 'a1' })
    expect(res.cookie).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      admin: { id: 'a1', email: 'root@factelec.fr' },
    })
  })

  it('logout: revokes the session and clears both cookies when a session cookie is present', async () => {
    const req = {
      cookies: { [SESSION_COOKIE]: 'tok' },
    } as unknown as SessionRequest
    const res = fakeResponse()

    await controller.logout(req, res)

    expect(sessions.revoke).toHaveBeenCalledWith('tok')
    expect(res.clearCookie).toHaveBeenCalledTimes(2)
  })

  it('logout: clears cookies without calling revoke when no session cookie is present (defensive)', async () => {
    const req = { cookies: {} } as unknown as SessionRequest
    const res = fakeResponse()

    await controller.logout(req, res)

    expect(sessions.revoke).not.toHaveBeenCalled()
    expect(res.clearCookie).toHaveBeenCalledTimes(2)
  })

  // Vecteur modifié (Task 3, spec §3) : le contrat HTTP change de forme
  // (tableau nu → `{ tenants: [...] }`, colonnes enrichies billing/volumes/
  // anomalies remplaçant userCount/invoiceCount) — la délégation elle-même
  // (contrôleur → service) reste inchangée, seule l'enveloppe de réponse
  // est nouvelle.
  it('listTenants: delegates to AdminService.listTenants, wraps the result in { tenants }', async () => {
    const tenants = [
      {
        id: 't1',
        name: 'Shop A',
        siren: null,
        createdAt: new Date(),
        suspendedAt: null,
        billingStatus: 'active',
        invoices30d: 3,
        ereporting30d: 1,
        deadLetters: 0,
      },
    ]
    admin.listTenants.mockResolvedValue(tenants)

    const result = await controller.listTenants()

    expect(admin.listTenants).toHaveBeenCalled()
    expect(result).toEqual({ tenants })
  })

  // Nouveau (Task 3, spec §3) : GET /admin/tenants/:id.
  describe('tenantDetail', () => {
    const VALID_UUID = '11111111-1111-1111-1111-111111111111'

    it('rejects a malformed id with 404 WITHOUT calling the service (isUuid guard, motif LedgerController/CdvController)', async () => {
      await expect(
        controller.tenantDetail('not-a-uuid'),
      ).rejects.toBeInstanceOf(NotFoundException)
      expect(admin.tenantDetail).not.toHaveBeenCalled()
    })

    it('returns 404 when the service reports no matching tenant (null) — indistinguishable from a malformed id', async () => {
      admin.tenantDetail.mockResolvedValue(null)

      const err = await controller.tenantDetail(VALID_UUID).catch((e) => e)

      expect(err).toBeInstanceOf(NotFoundException)
      expect(admin.tenantDetail).toHaveBeenCalledWith(VALID_UUID)
    })

    it('returns the detail object unchanged when the service finds the tenant', async () => {
      const detail: AdminTenantDetail = {
        id: VALID_UUID,
        name: 'Shop A',
        siren: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        suspendedAt: null,
        billingStatus: 'active',
        invoices30d: 3,
        ereporting30d: 1,
        deadLetters: 0,
        invoices: [
          {
            id: 'i1',
            number: 'F-1',
            lifecycleStatus: 'deposee',
            createdAt: new Date('2024-01-02T00:00:00Z'),
          },
        ],
        billing: {
          status: 'active',
          currentPeriodEnd: null,
          hasCustomer: true,
        },
      }
      admin.tenantDetail.mockResolvedValue(detail)

      const result = await controller.tenantDetail(VALID_UUID)

      expect(result).toEqual(detail)
    })
  })

  // Nouveau (Task 4, spec §3) : POST /admin/tenants/:id/suspend.
  describe('suspendTenant', () => {
    const VALID_UUID = '11111111-1111-1111-1111-111111111111'

    it('rejects a malformed id with 404 WITHOUT calling the service (isUuid guard)', async () => {
      await expect(
        controller.suspendTenant('not-a-uuid', { reason: 'abus' }, FAKE_ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException)
      expect(admin.suspendTenant).not.toHaveBeenCalled()
    })

    it('rejects an empty reason with 422 (zod, WITHOUT calling the service)', async () => {
      await expect(
        controller.suspendTenant(VALID_UUID, { reason: '' }, FAKE_ADMIN),
      ).rejects.toThrow()
      expect(admin.suspendTenant).not.toHaveBeenCalled()
    })

    it('404 when the service reports the tenant is unknown', async () => {
      admin.suspendTenant.mockResolvedValue({ outcome: 'not_found' })

      const err = await controller
        .suspendTenant(VALID_UUID, { reason: 'abus' }, FAKE_ADMIN)
        .catch((e) => e)

      expect(err).toBeInstanceOf(NotFoundException)
      expect(admin.suspendTenant).toHaveBeenCalledWith(VALID_UUID, 'a1', 'abus')
    })

    it('409 conflict when the tenant is already suspended (idempotence)', async () => {
      admin.suspendTenant.mockResolvedValue({ outcome: 'already_suspended' })

      const err = await controller
        .suspendTenant(VALID_UUID, { reason: 'abus' }, FAKE_ADMIN)
        .catch((e) => e)

      expect(err).toBeInstanceOf(ConflictException)
    })

    it('returns { suspendedAt } on success, forwarding the admin id from @CurrentAdmin', async () => {
      const suspendedAt = new Date('2026-07-19T12:00:00Z')
      admin.suspendTenant.mockResolvedValue({
        outcome: 'suspended',
        suspendedAt,
      })

      const result = await controller.suspendTenant(
        VALID_UUID,
        { reason: 'impayé grave' },
        FAKE_ADMIN,
      )

      expect(result).toEqual({ suspendedAt })
      expect(admin.suspendTenant).toHaveBeenCalledWith(
        VALID_UUID,
        'a1',
        'impayé grave',
      )
    })
  })

  // Nouveau (Task 4, spec §3) : POST /admin/tenants/:id/unsuspend.
  describe('unsuspendTenant', () => {
    const VALID_UUID = '11111111-1111-1111-1111-111111111111'

    it('rejects a malformed id with 404 WITHOUT calling the service (isUuid guard)', async () => {
      await expect(
        controller.unsuspendTenant('not-a-uuid', FAKE_ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException)
      expect(admin.unsuspendTenant).not.toHaveBeenCalled()
    })

    it('404 when the service reports the tenant is unknown', async () => {
      admin.unsuspendTenant.mockResolvedValue({ outcome: 'not_found' })

      await expect(
        controller.unsuspendTenant(VALID_UUID, FAKE_ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    it('409 conflict when the tenant is not suspended (idempotence)', async () => {
      admin.unsuspendTenant.mockResolvedValue({ outcome: 'not_suspended' })

      await expect(
        controller.unsuspendTenant(VALID_UUID, FAKE_ADMIN),
      ).rejects.toBeInstanceOf(ConflictException)
    })

    it('returns void (204) on success, forwarding the admin id from @CurrentAdmin', async () => {
      admin.unsuspendTenant.mockResolvedValue({ outcome: 'unsuspended' })

      const result = await controller.unsuspendTenant(VALID_UUID, FAKE_ADMIN)

      expect(result).toBeUndefined()
      expect(admin.unsuspendTenant).toHaveBeenCalledWith(VALID_UUID, 'a1')
    })
  })

  // Nouveau (Task 5, spec §3) : POST /admin/jobs/:queue/retry.
  describe('retryJobs', () => {
    it('defaults limit to 100 when the body is entirely absent (undefined, `?? {}` fallback)', async () => {
      jobs.retryFailed.mockResolvedValue({ retried: 0, errors: 0 })

      await controller.retryJobs('invoice-generation', undefined, FAKE_ADMIN)

      expect(jobs.retryFailed).toHaveBeenCalledWith(
        'invoice-generation',
        'a1',
        100,
      )
    })

    it('defaults limit to 100 when the body is empty, forwards the admin id from @CurrentAdmin', async () => {
      jobs.retryFailed.mockResolvedValue({ retried: 3, errors: 0 })

      const result = await controller.retryJobs(
        'invoice-generation',
        {},
        FAKE_ADMIN,
      )

      expect(jobs.retryFailed).toHaveBeenCalledWith(
        'invoice-generation',
        'a1',
        100,
      )
      expect(result).toEqual({ retried: 3, errors: 0 })
    })

    it('forwards an explicit limit within [1, 500]', async () => {
      jobs.retryFailed.mockResolvedValue({ retried: 0, errors: 0 })

      await controller.retryJobs('maintenance', { limit: 250 }, FAKE_ADMIN)

      expect(jobs.retryFailed).toHaveBeenCalledWith('maintenance', 'a1', 250)
    })

    it('rejects limit = 0 with a validation error, WITHOUT calling the service', async () => {
      await expect(
        controller.retryJobs('maintenance', { limit: 0 }, FAKE_ADMIN),
      ).rejects.toThrow()
      expect(jobs.retryFailed).not.toHaveBeenCalled()
    })

    it('rejects limit = 501 (above the 500 cap) with a validation error', async () => {
      await expect(
        controller.retryJobs('maintenance', { limit: 501 }, FAKE_ADMIN),
      ).rejects.toThrow()
      expect(jobs.retryFailed).not.toHaveBeenCalled()
    })

    it('404 when the service reports the queue name is outside the allowlist', async () => {
      jobs.retryFailed.mockResolvedValue(null)

      const err = await controller
        .retryJobs('not-a-real-queue', {}, FAKE_ADMIN)
        .catch((e) => e)

      expect(err).toBeInstanceOf(NotFoundException)
      expect(jobs.retryFailed).toHaveBeenCalledWith(
        'not-a-real-queue',
        'a1',
        100,
      )
    })
  })
})
