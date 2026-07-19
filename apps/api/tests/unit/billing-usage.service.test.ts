import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoices } from '../../src/db/schema.js'
import { BillingUsageService } from '../../src/worker/billing-usage.service.js'

// Orchestration UNIQUEMENT (le calcul de comptage `countDocuments` est
// exercé en e2e, Postgres réel, motif ereporting-sweep.service.test.ts qui
// délègue déjà period.ts au test dédié) : ici on prouve jour cible (J-1 UTC,
// horloge figée), l'enchaînement recordUsage→findUnreportedUsage→
// reportUsage→markUsageReported, et l'isolation d'erreur PAR TENANT (brief
// Task 9).

function fakeRepo(
  subscribed: { tenantId: string; stripeCustomerId: string }[] = [
    { tenantId: 't1', stripeCustomerId: 'cus_t1' },
  ],
) {
  return {
    listSubscribedTenants: vi.fn().mockResolvedValue(subscribed),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    findUnreportedUsage: vi.fn().mockResolvedValue([]),
    markUsageReported: vi.fn().mockResolvedValue(undefined),
  }
}

function fakePort() {
  return {
    reportUsage: vi.fn().mockResolvedValue(undefined),
  }
}

// Mock du même motif que BillingService (billing.service.test.ts) : `run`
// exécute directement `work(db)` ; `db.select().from(table).where()`
// distingue invoices/ereportingTransmissions par la RÉFÉRENCE de table, et le
// compte est choisi PAR TENANT (countsByTenant), jamais par ordre d'appel.
function fakeTenantContext(
  countsByTenant: Record<
    string,
    { invoices?: number; ereporting?: number }
  > = {},
) {
  const run = vi.fn(
    async (tenantId: string, work: (db: unknown) => Promise<unknown>) => {
      const c = countsByTenant[tenantId] ?? {}
      const db = {
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              Promise.resolve([
                {
                  n:
                    table === invoices
                      ? (c.invoices ?? 0)
                      : (c.ereporting ?? 0),
                },
              ]),
          }),
        }),
      }
      return work(db)
    },
  )
  return { run }
}

describe('BillingUsageService.sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calcule le jour cible comme la veille UTC (J-1)', async () => {
    const repo = fakeRepo([{ tenantId: 't1', stripeCustomerId: 'cus_t1' }])
    const tenantContext = fakeTenantContext({
      t1: { invoices: 2, ereporting: 1 },
    })
    const port = fakePort()
    const service = new BillingUsageService(
      repo as never,
      tenantContext as never,
      port as never,
    )

    await service.sweep()

    expect(repo.recordUsage).toHaveBeenCalledWith('t1', '2026-07-18', 3)
  })

  it('flux nominal : record→findUnreported→report→mark, retour {tenants, reported} correct', async () => {
    const repo = fakeRepo([{ tenantId: 't1', stripeCustomerId: 'cus_t1' }])
    repo.findUnreportedUsage.mockResolvedValue([
      { id: 'u1', day: '2026-07-18', count: 3 },
    ])
    const tenantContext = fakeTenantContext({
      t1: { invoices: 2, ereporting: 1 },
    })
    const port = fakePort()
    const service = new BillingUsageService(
      repo as never,
      tenantContext as never,
      port as never,
    )

    const result = await service.sweep()

    expect(repo.recordUsage).toHaveBeenCalledWith('t1', '2026-07-18', 3)
    expect(repo.findUnreportedUsage).toHaveBeenCalledWith('t1')
    expect(port.reportUsage).toHaveBeenCalledWith([
      { customerId: 'cus_t1', day: '2026-07-18', count: 3 },
    ])
    expect(repo.markUsageReported).toHaveBeenCalledWith('t1', 'u1')
    expect(result).toEqual({ tenants: 1, reported: 1 })
  })

  it("n'appelle ni le port ni markUsageReported quand aucune ligne n'est en attente de report", async () => {
    const repo = fakeRepo([{ tenantId: 't1', stripeCustomerId: 'cus_t1' }])
    repo.findUnreportedUsage.mockResolvedValue([])
    const tenantContext = fakeTenantContext({ t1: {} })
    const port = fakePort()
    const service = new BillingUsageService(
      repo as never,
      tenantContext as never,
      port as never,
    )

    const result = await service.sweep()

    expect(port.reportUsage).not.toHaveBeenCalled()
    expect(repo.markUsageReported).not.toHaveBeenCalled()
    expect(result).toEqual({ tenants: 1, reported: 0 })
  })

  it('agrège plusieurs lignes non reportées en UN SEUL appel port.reportUsage puis les marque chacune', async () => {
    const repo = fakeRepo([{ tenantId: 't1', stripeCustomerId: 'cus_t1' }])
    repo.findUnreportedUsage.mockResolvedValue([
      { id: 'u1', day: '2026-07-17', count: 2 },
      { id: 'u2', day: '2026-07-18', count: 3 },
    ])
    const tenantContext = fakeTenantContext({ t1: {} })
    const port = fakePort()
    const service = new BillingUsageService(
      repo as never,
      tenantContext as never,
      port as never,
    )

    const result = await service.sweep()

    expect(port.reportUsage).toHaveBeenCalledTimes(1)
    expect(port.reportUsage).toHaveBeenCalledWith([
      { customerId: 'cus_t1', day: '2026-07-17', count: 2 },
      { customerId: 'cus_t1', day: '2026-07-18', count: 3 },
    ])
    expect(repo.markUsageReported).toHaveBeenCalledTimes(2)
    expect(repo.markUsageReported).toHaveBeenNthCalledWith(1, 't1', 'u1')
    expect(repo.markUsageReported).toHaveBeenNthCalledWith(2, 't1', 'u2')
    expect(result).toEqual({ tenants: 1, reported: 2 })
  })

  it("isole l'échec reportUsage d'un tenant (mark PAS appelé pour lui) — les autres tenants sont traités quand même", async () => {
    const repo = fakeRepo([
      { tenantId: 'tA', stripeCustomerId: 'cus_A' },
      { tenantId: 'tB', stripeCustomerId: 'cus_B' },
    ])
    repo.findUnreportedUsage.mockImplementation((tenantId: string) =>
      Promise.resolve(
        tenantId === 'tA'
          ? [{ id: 'uA', day: '2026-07-18', count: 1 }]
          : [{ id: 'uB', day: '2026-07-18', count: 2 }],
      ),
    )
    const tenantContext = fakeTenantContext({ tA: {}, tB: {} })
    const port = fakePort()
    port.reportUsage.mockImplementation((events: { customerId: string }[]) => {
      if (events[0]?.customerId === 'cus_A') {
        return Promise.reject(new Error('stripe down'))
      }
      return Promise.resolve(undefined)
    })
    const service = new BillingUsageService(
      repo as never,
      tenantContext as never,
      port as never,
    )

    const result = await service.sweep()

    expect(repo.markUsageReported).not.toHaveBeenCalledWith('tA', 'uA')
    expect(repo.markUsageReported).toHaveBeenCalledWith('tB', 'uB')
    expect(result).toEqual({ tenants: 2, reported: 1 })
  })

  it("est un no-op ({tenants: 0, reported: 0}) quand aucun tenant n'est abonné", async () => {
    const repo = fakeRepo([])
    const tenantContext = fakeTenantContext({})
    const port = fakePort()
    const service = new BillingUsageService(
      repo as never,
      tenantContext as never,
      port as never,
    )

    const result = await service.sweep()

    expect(repo.recordUsage).not.toHaveBeenCalled()
    expect(result).toEqual({ tenants: 0, reported: 0 })
  })
})
