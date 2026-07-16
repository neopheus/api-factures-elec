import { beforeEach, describe, expect, it, vi } from 'vitest'

// computeDuePeriods/computeDuePaymentPeriods (period.ts, pures) sont déjà
// 100 % couvertes et testées sur vecteurs fixes (tests/unit/period.test.ts).
// Ici, on teste UNIQUEMENT l'orchestration du sweep (déclarants dus →
// périodes (transactions ET payments) → enfilement) — le mock évite toute
// dépendance à l'horloge système réelle (`new Date()` est appelé DANS le
// service, cf. son commentaire). Noms préfixés `mock` requis par Vitest pour
// être référencés dans la factory hoistée.
const mockComputeDuePeriods = vi.fn()
const mockComputeDuePaymentPeriods = vi.fn()
vi.mock('../../src/ereporting/period.js', () => ({
  computeDuePeriods: (...args: unknown[]) => mockComputeDuePeriods(...args),
  computeDuePaymentPeriods: (...args: unknown[]) =>
    mockComputeDuePaymentPeriods(...args),
}))

const { EreportingSweepService } = await import(
  '../../src/worker/ereporting-sweep.service.js'
)

function build(rows: unknown[]) {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  const queue = { add: vi.fn().mockResolvedValue(undefined) }
  const service = new EreportingSweepService(pool as never, queue as never)
  return { service, pool, queue }
}

describe('EreportingSweepService.sweep', () => {
  beforeEach(() => {
    mockComputeDuePeriods.mockReset()
    mockComputeDuePaymentPeriods.mockReset()
    // Défaut neutre (aucune période payment due) pour ne pas casser les tests
    // qui ne s'intéressent qu'à la passe transactions.
    mockComputeDuePaymentPeriods.mockReturnValue([])
  })

  it('is a no-op (returns 0) when no declarant is due', async () => {
    const { service, pool, queue } = build([])

    const n = await service.sweep()

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id, id, vat_regime, role, siren, name FROM find_ereporting_declarants_due()',
    )
    expect(queue.add).not.toHaveBeenCalled()
    expect(mockComputeDuePeriods).not.toHaveBeenCalled()
    expect(mockComputeDuePaymentPeriods).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })

  it('enqueues one ereporting-generation job per due period, with deterministic jobId and minimal payload', async () => {
    const rows = [
      {
        tenant_id: 't1',
        id: 'decl-1',
        vat_regime: 'reel_normal_mensuel',
        role: 'SE',
        siren: '111111111',
        name: 'V',
      },
    ]
    mockComputeDuePeriods.mockReturnValue([
      { periodStart: '20260901', periodEnd: '20260910' },
      { periodStart: '20260821', periodEnd: '20260831' },
    ])
    const { service, queue } = build(rows)

    const n = await service.sweep()

    expect(mockComputeDuePeriods).toHaveBeenCalledWith(
      'reel_normal_mensuel',
      expect.any(Date),
    )
    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'ereporting-generate',
      {
        tenantId: 't1',
        declarantId: 'decl-1',
        siren: '111111111',
        role: 'SE',
        fluxKind: 'transactions',
        periodStart: '20260901',
        periodEnd: '20260910',
        type: 'IN',
      },
      { jobId: 'decl-1:transactions:20260901' },
    )
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      'ereporting-generate',
      expect.objectContaining({
        periodStart: '20260821',
        periodEnd: '20260831',
      }),
      { jobId: 'decl-1:transactions:20260821' },
    )
    expect(n).toBe(2)
  })

  it('sweeps each declarant independently, using ITS OWN vat_regime', async () => {
    const rows = [
      {
        tenant_id: 't1',
        id: 'd1',
        vat_regime: 'reel_normal_mensuel',
        role: 'SE',
        siren: '1',
        name: 'A',
      },
      {
        tenant_id: 't2',
        id: 'd2',
        vat_regime: 'franchise',
        role: 'BY',
        siren: '2',
        name: 'B',
      },
    ]
    mockComputeDuePeriods
      .mockReturnValueOnce([{ periodStart: '20260901', periodEnd: '20260910' }])
      .mockReturnValueOnce([])
    const { service, queue } = build(rows)

    const n = await service.sweep()

    expect(mockComputeDuePeriods).toHaveBeenCalledTimes(2)
    expect(mockComputeDuePeriods).toHaveBeenNthCalledWith(
      1,
      'reel_normal_mensuel',
      expect.any(Date),
    )
    expect(mockComputeDuePeriods).toHaveBeenNthCalledWith(
      2,
      'franchise',
      expect.any(Date),
    )
    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(n).toBe(1)
  })

  it('enqueues a payments job per due payment period, jobId dash-separated, distinct from the transactions slot (D7, Task 8)', async () => {
    mockComputeDuePeriods.mockReturnValue([])
    mockComputeDuePaymentPeriods.mockReturnValue([
      { periodStart: '20260801', periodEnd: '20260831' },
    ])
    const rows = [
      {
        tenant_id: 't1',
        id: 'decl-1',
        vat_regime: 'reel_normal_mensuel',
        role: 'SE',
        siren: '111111111',
        name: 'V',
      },
    ]
    const { service, queue } = build(rows)

    const n = await service.sweep()

    expect(mockComputeDuePaymentPeriods).toHaveBeenCalledWith(
      'reel_normal_mensuel',
      expect.any(Date),
    )
    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'ereporting-generate',
      {
        tenantId: 't1',
        declarantId: 'decl-1',
        siren: '111111111',
        role: 'SE',
        fluxKind: 'payments',
        periodStart: '20260801',
        periodEnd: '20260831',
        type: 'IN',
      },
      { jobId: 'decl-1-payments-20260801' },
    )
    expect(n).toBe(1)
  })

  it('enqueues BOTH a transactions job and a payments job for the same declarant when both cadences are due, on disjoint jobIds', async () => {
    mockComputeDuePeriods.mockReturnValue([
      { periodStart: '20260901', periodEnd: '20260910' },
    ])
    mockComputeDuePaymentPeriods.mockReturnValue([
      { periodStart: '20260801', periodEnd: '20260831' },
    ])
    const rows = [
      {
        tenant_id: 't1',
        id: 'decl-1',
        vat_regime: 'simplifie',
        role: 'SE',
        siren: '1',
        name: 'A',
      },
    ]
    const { service, queue } = build(rows)

    const n = await service.sweep()

    expect(queue.add).toHaveBeenCalledTimes(2)
    const jobIds = queue.add.mock.calls.map((call) => call[2].jobId)
    expect(jobIds).toEqual([
      'decl-1:transactions:20260901',
      'decl-1-payments-20260801',
    ])
    const fluxKinds = queue.add.mock.calls.map((call) => call[1].fluxKind)
    expect(fluxKinds).toEqual(['transactions', 'payments'])
    expect(n).toBe(2)
  })

  it('a due payment period with no due transaction period still enqueues (passes are independent)', async () => {
    mockComputeDuePeriods.mockReturnValue([])
    mockComputeDuePaymentPeriods.mockReturnValue([
      { periodStart: '20260801', periodEnd: '20260831' },
    ])
    const rows = [
      {
        tenant_id: 't1',
        id: 'decl-1',
        vat_regime: 'franchise',
        role: 'SE',
        siren: '1',
        name: 'A',
      },
    ]
    const { service, queue } = build(rows)

    const n = await service.sweep()

    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(queue.add.mock.calls[0]![1]).toMatchObject({ fluxKind: 'payments' })
    expect(n).toBe(1)
  })
})
