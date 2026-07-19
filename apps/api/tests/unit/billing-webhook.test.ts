import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BillingSignatureError,
  type BillingWebhookEvent,
} from '../../src/billing/billing.port.js'
import { BillingWebhookService } from '../../src/billing/billing-webhook.service.js'

const TENANT = 'tenant-1'
const CUSTOMER = 'cus_1'

function validEvent(
  overrides: Partial<BillingWebhookEvent> = {},
): BillingWebhookEvent {
  return {
    customerId: CUSTOMER,
    occurredAt: new Date('2026-07-19T10:00:00Z'),
    subscriptionId: 'sub_1',
    status: 'active',
    currentPeriodEnd: new Date('2026-08-19T00:00:00Z'),
    ...overrides,
  }
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    ensureCustomer: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    reportUsage: vi.fn(),
    constructWebhookEvent: vi.fn().mockReturnValue(validEvent()),
    ...overrides,
  }
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findTenantByCustomer: vi.fn().mockResolvedValue(TENANT),
    applyEvent: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

describe('BillingWebhookService', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  const raw = Buffer.from('{}')
  const signature = 'sig'

  it('signature invalide (BillingSignatureError) → { handled: false, reason: "signature" }, applyEvent jamais appelé', async () => {
    const port = fakePort({
      constructWebhookEvent: vi.fn(() => {
        throw new BillingSignatureError('signature invalide')
      }),
    })
    const repo = fakeRepo()
    const service = new BillingWebhookService(port as never, repo as never)

    const result = await service.handle(raw, signature)

    expect(result).toEqual({ handled: false, reason: 'signature' })
    expect(repo.findTenantByCustomer).not.toHaveBeenCalled()
    expect(repo.applyEvent).not.toHaveBeenCalled()
  })

  it('customerId null → { handled: false, reason: "unknown-customer" } + log warn, findTenantByCustomer jamais appelé', async () => {
    const port = fakePort({
      constructWebhookEvent: vi
        .fn()
        .mockReturnValue(validEvent({ customerId: null })),
    })
    const repo = fakeRepo()
    const service = new BillingWebhookService(port as never, repo as never)

    const result = await service.handle(raw, signature)

    expect(result).toEqual({ handled: false, reason: 'unknown-customer' })
    expect(repo.findTenantByCustomer).not.toHaveBeenCalled()
    expect(repo.applyEvent).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('customer Stripe inconnu (findTenantByCustomer → null) → { handled: false, reason: "unknown-customer" } + log warn', async () => {
    const port = fakePort()
    const repo = fakeRepo({
      findTenantByCustomer: vi.fn().mockResolvedValue(null),
    })
    const service = new BillingWebhookService(port as never, repo as never)

    const result = await service.handle(raw, signature)

    expect(result).toEqual({ handled: false, reason: 'unknown-customer' })
    expect(repo.findTenantByCustomer).toHaveBeenCalledWith(CUSTOMER)
    expect(repo.applyEvent).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('événement sans statut (status: null) → { handled: false, reason: "no-status" }, applyEvent JAMAIS appelé', async () => {
    const port = fakePort({
      constructWebhookEvent: vi
        .fn()
        .mockReturnValue(validEvent({ status: null })),
    })
    const repo = fakeRepo()
    const service = new BillingWebhookService(port as never, repo as never)

    const result = await service.handle(raw, signature)

    expect(result).toEqual({ handled: false, reason: 'no-status' })
    expect(repo.applyEvent).not.toHaveBeenCalled()
  })

  it('événement valide → applyEvent(tenantId, evt) appelé avec les bons arguments, { handled: true }', async () => {
    const evt = validEvent()
    const port = fakePort({
      constructWebhookEvent: vi.fn().mockReturnValue(evt),
    })
    const repo = fakeRepo()
    const service = new BillingWebhookService(port as never, repo as never)

    const result = await service.handle(raw, signature)

    expect(result).toEqual({ handled: true })
    expect(repo.findTenantByCustomer).toHaveBeenCalledWith(CUSTOMER)
    expect(repo.applyEvent).toHaveBeenCalledWith(TENANT, evt)
  })

  it('constructWebhookEvent throw une Error générique (PAS BillingSignatureError) → handle REJETTE (promesse rejetée, PAS { handled: false }) — M10', async () => {
    const port = fakePort({
      constructWebhookEvent: vi.fn(() => {
        throw new Error('stripe SDK erreur inattendue')
      }),
    })
    const repo = fakeRepo()
    const service = new BillingWebhookService(port as never, repo as never)

    // Contrat du commentaire de tête de billing-webhook.service.ts : SEULE
    // une BillingSignatureError est traduite en { handled: false, reason:
    // 'signature' } — toute autre erreur du port doit remonter TELLE QUELLE
    // (500 via le filtre global côté controller), jamais avalée en résultat
    // { handled: false }.
    await expect(service.handle(raw, signature)).rejects.toThrow(
      'stripe SDK erreur inattendue',
    )
    expect(repo.findTenantByCustomer).not.toHaveBeenCalled()
    expect(repo.applyEvent).not.toHaveBeenCalled()
  })

  it('applyEvent → false (événement hors ordre) → { handled: false, reason: "stale" }', async () => {
    const port = fakePort()
    const repo = fakeRepo({ applyEvent: vi.fn().mockResolvedValue(false) })
    const service = new BillingWebhookService(port as never, repo as never)

    const result = await service.handle(raw, signature)

    expect(result).toEqual({ handled: false, reason: 'stale' })
  })
})
