import { NotFoundException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminController } from '../../src/admin/admin.controller.js'
import type { AdminService } from '../../src/admin/admin.service.js'
import type { AdminTenantDetail } from '../../src/admin/admin-supervision.repository.js'
import type { SessionRequest } from '../../src/auth/auth.types.js'
import type { SessionService } from '../../src/auth/session.service.js'
import { SESSION_COOKIE } from '../../src/auth/session-token.js'
import type { EnvConfig } from '../../src/config/env.js'

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
  }
  let sessions: {
    create: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
    ttlMs: ReturnType<typeof vi.fn>
  }
  let controller: AdminController

  beforeEach(() => {
    admin = { login: vi.fn(), listTenants: vi.fn(), tenantDetail: vi.fn() }
    sessions = {
      create: vi.fn(),
      revoke: vi.fn(),
      ttlMs: vi.fn().mockReturnValue(1000),
    }
    controller = new AdminController(
      admin as unknown as AdminService,
      sessions as unknown as SessionService,
      fakeConfig(),
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
})
