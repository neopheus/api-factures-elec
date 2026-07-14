import { describe, expect, it, vi } from 'vitest'
import { RECONCILE_INVOICES_JOB } from '../../src/queue/maintenance.job.js'
import { ReconciliationScheduler } from '../../src/worker/reconciliation.scheduler.js'

function fakeConfig(everyMs: number) {
  return { get: () => everyMs } as never
}

describe('ReconciliationScheduler.onApplicationBootstrap', () => {
  it('upserts the repeatable scheduler with the configured cadence', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new ReconciliationScheduler(
      queue as never,
      fakeConfig(60_000),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'invoice-reconciliation',
      { every: 60_000 },
      { name: RECONCILE_INVOICES_JOB },
    )
  })
})
