import type { ExecutionContext } from '@nestjs/common'
import { HttpException, Logger } from '@nestjs/common'
import { Counter } from 'prom-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantRequest } from '../../src/auth/api-key.guard.js'
import { BillingGuard } from '../../src/billing/billing.guard.js'
import type { BillingSubscriptionStatus } from '../../src/billing/billing.port.js'
import type { BillingRepository } from '../../src/billing/billing.repository.js'
import { ProblemType } from '../../src/common/problem.js'
import type { EnvConfig } from '../../src/config/env.js'
import { MetricsService } from '../../src/metrics/metrics.service.js'

function fakeConfig(
  driver: EnvConfig['BILLING_DRIVER'],
  enforcement: EnvConfig['BILLING_ENFORCEMENT'],
) {
  return {
    get: (key: string) => (key === 'BILLING_DRIVER' ? driver : enforcement),
  } as never
}

function mockContext(tenantId?: string): {
  ctx: ExecutionContext
  req: TenantRequest
} {
  const req = {
    tenantId,
    method: 'POST',
    originalUrl: '/invoices',
  } as unknown as TenantRequest
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

function state(status: BillingSubscriptionStatus) {
  return {
    status,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
  }
}

describe('BillingGuard', () => {
  let getState: ReturnType<typeof vi.fn>
  let metrics: MetricsService

  beforeEach(() => {
    getState = vi.fn()
    metrics = new MetricsService()
  })

  it("driver='none' neutralise inconditionnellement le garde, même enforcement='on' (spec §4) — jamais d'appel au repository", async () => {
    const guard = new BillingGuard(
      { getState } as unknown as BillingRepository,
      fakeConfig('none', 'on'),
      metrics,
    )
    const { ctx } = mockContext('tenant-1')

    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(getState).not.toHaveBeenCalled()
  })

  it('req.tenantId absent (guard d’auth manquant en amont) → throw Error interne, jamais un 402 conservateur', async () => {
    const guard = new BillingGuard(
      { getState } as unknown as BillingRepository,
      fakeConfig('fake', 'on'),
      metrics,
    )
    const { ctx } = mockContext(undefined)

    const err = await guard.canActivate(ctx).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(HttpException)
    expect((err as Error).message).toMatch(
      /BillingGuard exige un guard d'authentification en amont/,
    )
    expect(getState).not.toHaveBeenCalled()
  })

  it("driver='fake', enforcement='off', statut bloquant (none) → PASSE + log warn (tenant, statut, route), AUCUN denial comptabilisé", async () => {
    getState.mockResolvedValue(state('none'))
    const guard = new BillingGuard(
      { getState } as unknown as BillingRepository,
      fakeConfig('fake', 'off'),
      metrics,
    )
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    const { ctx } = mockContext('tenant-1')

    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(getState).toHaveBeenCalledWith('tenant-1')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [msg] = warnSpy.mock.calls[0] as [string]
    expect(msg).toContain('tenant-1')
    expect(msg).toContain('none')
    expect(msg).toContain('/invoices')
    warnSpy.mockRestore()
    // Enforcement OFF : le garde OBSERVE et laisse passer, aucun blocage
    // effectif — `billing_guard_denials_total` ne doit compter QUE les
    // requêtes réellement bloquées (402), pas les tenants qui l'auraient été
    // (prom-client initialise un Counter fraîchement créé à 0, jamais absent).
    const text = await metrics.render()
    expect(text).toContain('billing_guard_denials_total 0')
  })

  it.each<BillingSubscriptionStatus>(['active', 'trialing', 'past_due'])(
    "driver='fake', enforcement='on', statut %s → PASSE",
    async (status) => {
      getState.mockResolvedValue(state(status))
      const guard = new BillingGuard(
        { getState } as unknown as BillingRepository,
        fakeConfig('fake', 'on'),
        metrics,
      )
      const { ctx } = mockContext('tenant-1')

      await expect(guard.canActivate(ctx)).resolves.toBe(true)
      expect(getState).toHaveBeenCalledWith('tenant-1')
    },
  )

  it.each<BillingSubscriptionStatus>([
    'none',
    'unpaid',
    'canceled',
    'incomplete',
  ])(
    "driver='fake', enforcement='on', statut %s → 402 urn:factelec:problem:subscription-required + compteur billing_guard_denials_total incrémenté",
    async (status) => {
      getState.mockResolvedValue(state(status))
      const guard = new BillingGuard(
        { getState } as unknown as BillingRepository,
        fakeConfig('fake', 'on'),
        metrics,
      )
      const { ctx } = mockContext('tenant-1')

      const err = await guard.canActivate(ctx).catch((e) => e)
      expect(err).toBeInstanceOf(HttpException)
      expect((err as HttpException).getStatus()).toBe(402)
      expect((err as HttpException).getResponse()).toMatchObject({
        status: 402,
        type: ProblemType.paymentRequired,
        title: 'Subscription required',
      })
      const text = await metrics.render()
      expect(text).toContain('billing_guard_denials_total 1')
    },
  )

  it("driver='stripe' suit la même logique d'enforcement que 'fake' (seul 'none' neutralise)", async () => {
    getState.mockResolvedValue(state('canceled'))
    const guard = new BillingGuard(
      { getState } as unknown as BillingRepository,
      fakeConfig('stripe', 'on'),
      metrics,
    )
    const { ctx } = mockContext('tenant-1')

    const err = await guard.canActivate(ctx).catch((e) => e)
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(402)
  })

  it('deux denials consécutifs → le compteur cumule (pas de reset entre requêtes)', async () => {
    getState.mockResolvedValue(state('canceled'))
    const guard = new BillingGuard(
      { getState } as unknown as BillingRepository,
      fakeConfig('fake', 'on'),
      metrics,
    )
    const { ctx } = mockContext('tenant-1')

    await guard.canActivate(ctx).catch(() => undefined)
    await guard.canActivate(ctx).catch(() => undefined)

    const text = await metrics.render()
    expect(text).toContain('billing_guard_denials_total 2')
  })

  it('compteur billing_guard_denials_total déjà enregistré sur CE registre (nom en collision) → le garde reste fonctionnel (402 toujours levé), échec de création avalé + log warn', async () => {
    // Pré-enregistre un compteur de même nom sur le MÊME registre pour
    // forcer `new Counter(...)` à throw dans le constructeur de BillingGuard
    // (prom-client refuse un nom dupliqué sur un même registre) — garantit
    // que le garde reste « optional-friendly » (brief Task 9) : une panne
    // d'observabilité ne doit JAMAIS rendre l'enforcement inopérant.
    // biome-ignore lint/correctness/noUnusedVariables: seule la CRÉATION (effet de bord sur le registre) importe ici.
    const collision = new Counter({
      name: 'billing_guard_denials_total',
      help: 'collision volontaire',
      registers: [metrics.registry],
    })
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    getState.mockResolvedValue(state('canceled'))

    const guard = new BillingGuard(
      { getState } as unknown as BillingRepository,
      fakeConfig('fake', 'on'),
      metrics,
    )
    const { ctx } = mockContext('tenant-1')

    const err = await guard.canActivate(ctx).catch((e) => e)

    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(402)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('billing_guard_denials_total'),
    )
    warnSpy.mockRestore()
  })
})
