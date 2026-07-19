import { ConflictException, ServiceUnavailableException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingDisabledError } from '../../src/billing/billing.port.js'
import { BillingService } from '../../src/billing/billing.service.js'
import type { EnvConfig } from '../../src/config/env.js'
import { tenants } from '../../src/db/schema.js'
import type { TenantContextService } from '../../src/db/tenant-context.service.js'

const DASHBOARD_URL = 'https://dashboard.example.com'
const TENANT = 'tenant-1'
const USER = 'user-1'

const noneState = {
  status: 'none' as const,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: null,
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    ensureCustomer: vi.fn().mockResolvedValue('cus_new'),
    createCheckoutSession: vi
      .fn()
      .mockResolvedValue('https://stripe.test/checkout/1'),
    createPortalSession: vi
      .fn()
      .mockResolvedValue('https://stripe.test/portal/1'),
    reportUsage: vi.fn(),
    constructWebhookEvent: vi.fn(),
    ...overrides,
  }
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    getState: vi.fn().mockResolvedValue(noneState),
    attachCustomer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function fakeConfig(
  dashboardUrl = DASHBOARD_URL,
): ConfigService<EnvConfig, true> {
  return {
    get: (key: keyof EnvConfig) =>
      key === 'BILLING_DASHBOARD_URL' ? dashboardUrl : undefined,
  } as unknown as ConfigService<EnvConfig, true>
}

// Mock du même motif que UsersService.me (users.service.test.ts) : `run`
// exécute directement `work(db)`, `db.select().from(table).where().limit()`
// distingue tenants/users par la RÉFÉRENCE de table passée à `.from()`
// (jamais par ordre d'appel — plus robuste).
function fakeTenantContext(
  tenantRow: { name: string; siren: string | null } | undefined = {
    name: 'Acme',
    siren: '123456789',
  },
  userRow: { email: string } | undefined = { email: 'owner@ex.com' },
): { run: ReturnType<typeof vi.fn> } & TenantContextService {
  const run = vi.fn(
    async (_tenantId: string, work: (db: unknown) => Promise<unknown>) => {
      const db = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: () =>
                Promise.resolve(
                  table === tenants
                    ? tenantRow
                      ? [tenantRow]
                      : []
                    : userRow
                      ? [userRow]
                      : [],
                ),
            }),
          }),
        }),
      }
      return work(db)
    },
  )
  return { run } as unknown as {
    run: ReturnType<typeof vi.fn>
  } & TenantContextService
}

describe('BillingService', () => {
  let port: ReturnType<typeof fakePort>
  let repo: ReturnType<typeof fakeRepo>
  let tenantContext: ReturnType<typeof fakeTenantContext>
  let service: BillingService

  beforeEach(() => {
    port = fakePort()
    repo = fakeRepo()
    tenantContext = fakeTenantContext()
    service = new BillingService(
      port as never,
      repo as never,
      tenantContext as never,
      fakeConfig(),
    )
  })

  describe('checkoutSession', () => {
    it('crée le customer (meta tenant + email du user de session) puis l’attache et renvoie l’URL, quand le tenant n’a pas encore de customer', async () => {
      const { url } = await service.checkoutSession(TENANT, USER)

      expect(port.ensureCustomer).toHaveBeenCalledWith({
        tenantId: TENANT,
        name: 'Acme',
        siren: '123456789',
        email: 'owner@ex.com',
      })
      expect(repo.attachCustomer).toHaveBeenCalledWith(TENANT, 'cus_new')
      expect(port.createCheckoutSession).toHaveBeenCalledWith(
        'cus_new',
        `${DASHBOARD_URL}/billing?checkout=success`,
        `${DASHBOARD_URL}/billing?checkout=cancel`,
      )
      expect(url).toBe('https://stripe.test/checkout/1')
    })

    it('réutilise le customer existant sans le recréer, quand le tenant a déjà un customer Stripe', async () => {
      repo.getState.mockResolvedValue({
        ...noneState,
        stripeCustomerId: 'cus_existing',
      })

      const { url } = await service.checkoutSession(TENANT, USER)

      expect(port.ensureCustomer).not.toHaveBeenCalled()
      expect(repo.attachCustomer).not.toHaveBeenCalled()
      expect(port.createCheckoutSession).toHaveBeenCalledWith(
        'cus_existing',
        `${DASHBOARD_URL}/billing?checkout=success`,
        `${DASHBOARD_URL}/billing?checkout=cancel`,
      )
      expect(url).toBe('https://stripe.test/checkout/1')
    })

    it('driver désactivé (BillingDisabledError) → 503 problem billingDisabled', async () => {
      repo.getState.mockResolvedValue({
        ...noneState,
        stripeCustomerId: 'cus_existing',
      })
      port.createCheckoutSession.mockRejectedValue(
        new BillingDisabledError('billing désactivé'),
      )

      const err = await service.checkoutSession(TENANT, USER).catch((e) => e)

      expect(err).toBeInstanceOf(ServiceUnavailableException)
      expect(err.getStatus()).toBe(503)
      expect(err.getResponse()).toMatchObject({
        type: 'urn:factelec:problem:billing-disabled',
        status: 503,
      })
    })
  })

  describe('portalSession', () => {
    it('409 conflict quand le tenant n’a pas de customer (jamais passé par checkout)', async () => {
      const err = await service.portalSession(TENANT).catch((e) => e)

      expect(err).toBeInstanceOf(ConflictException)
      expect(err.getStatus()).toBe(409)
      expect(err.getResponse()).toMatchObject({
        type: 'urn:factelec:problem:conflict',
        status: 409,
      })
      expect(port.createPortalSession).not.toHaveBeenCalled()
    })

    it('renvoie l’URL du portail quand le tenant a un customer', async () => {
      repo.getState.mockResolvedValue({
        ...noneState,
        stripeCustomerId: 'cus_existing',
      })

      const { url } = await service.portalSession(TENANT)

      expect(port.createPortalSession).toHaveBeenCalledWith(
        'cus_existing',
        `${DASHBOARD_URL}/billing`,
      )
      expect(url).toBe('https://stripe.test/portal/1')
    })

    it('driver désactivé (BillingDisabledError) → 503 problem billingDisabled', async () => {
      repo.getState.mockResolvedValue({
        ...noneState,
        stripeCustomerId: 'cus_existing',
      })
      port.createPortalSession.mockRejectedValue(
        new BillingDisabledError('billing désactivé'),
      )

      const err = await service.portalSession(TENANT).catch((e) => e)

      expect(err).toBeInstanceOf(ServiceUnavailableException)
      expect(err.getStatus()).toBe(503)
      expect(err.getResponse()).toMatchObject({
        type: 'urn:factelec:problem:billing-disabled',
      })
    })
  })

  describe('status', () => {
    it('relaie getState (none) sans jamais toucher le port', async () => {
      const result = await service.status(TENANT)

      expect(result).toEqual({
        status: 'none',
        currentPeriodEnd: null,
        hasCustomer: false,
      })
      expect(port.ensureCustomer).not.toHaveBeenCalled()
      expect(port.createCheckoutSession).not.toHaveBeenCalled()
      expect(port.createPortalSession).not.toHaveBeenCalled()
    })

    it('relaie getState (active, avec période courante et customer) en ISO string', async () => {
      repo.getState.mockResolvedValue({
        status: 'active',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        currentPeriodEnd: new Date('2026-08-19T00:00:00.000Z'),
      })

      const result = await service.status(TENANT)

      expect(result).toEqual({
        status: 'active',
        currentPeriodEnd: '2026-08-19T00:00:00.000Z',
        hasCustomer: true,
      })
    })

    it('ne touche jamais le port même si le driver est désactivé (miroir seul)', async () => {
      const throwingPort = fakePort({
        ensureCustomer: vi
          .fn()
          .mockRejectedValue(new BillingDisabledError('x')),
        createCheckoutSession: vi
          .fn()
          .mockRejectedValue(new BillingDisabledError('x')),
        createPortalSession: vi
          .fn()
          .mockRejectedValue(new BillingDisabledError('x')),
      })
      const svc = new BillingService(
        throwingPort as never,
        repo as never,
        tenantContext as never,
        fakeConfig(),
      )

      await expect(svc.status(TENANT)).resolves.toEqual({
        status: 'none',
        currentPeriodEnd: null,
        hasCustomer: false,
      })
    })
  })
})
