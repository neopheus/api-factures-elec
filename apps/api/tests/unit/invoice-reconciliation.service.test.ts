import { describe, expect, it, vi } from 'vitest'
import { InvoiceReconciliationService } from '../../src/worker/invoice-reconciliation.service.js'

function fakeConfig(
  staleMs: number,
  generatingStaleMs: number,
  maxAttemptsCap = 5,
) {
  return {
    get: (key: string) =>
      ({
        RECONCILIATION_STALE_MS: staleMs,
        RECONCILIATION_GENERATING_STALE_MS: generatingStaleMs,
        GENERATION_MAX_ATTEMPTS_CAP: maxAttemptsCap,
      })[key],
  } as never
}

function fakeRepo(attempts: number | ((n: number) => number) = 1) {
  let n = 0
  return {
    bumpReconcileAttempts: vi.fn(async () => {
      n = typeof attempts === 'function' ? attempts(n) : attempts
      return n
    }),
    markGenerationStatus: vi.fn(async () => {}),
    recordDeadLetter: vi.fn(async () => {}),
  }
}

describe('InvoiceReconciliationService.sweepStuckGeneration', () => {
  it('queries both thresholds (received + generating) and re-enqueues orphans (no existing job)', async () => {
    const rows = [
      { tenant_id: 't1', id: 'i1' },
      { tenant_id: 't2', id: 'i2' },
    ]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = {
      getJobState: vi.fn().mockResolvedValue(undefined),
      removeJob: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(undefined),
    }
    const repo = fakeRepo(1)
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      repo as never,
      fakeConfig(300_000, 900_000),
    )

    const n = await service.sweepStuckGeneration()

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id, id FROM find_stuck_generation_invoices($1, $2)',
      [300_000, 900_000],
    )
    expect(queue.enqueue).toHaveBeenCalledWith('t1', 'i1')
    expect(queue.enqueue).toHaveBeenCalledWith('t2', 'i2')
    expect(queue.enqueue).toHaveBeenCalledTimes(2)
    expect(queue.removeJob).not.toHaveBeenCalled()
    expect(repo.bumpReconcileAttempts).toHaveBeenCalledTimes(2)
    expect(repo.markGenerationStatus).not.toHaveBeenCalled()
    expect(repo.recordDeadLetter).not.toHaveBeenCalled()
    expect(n).toBe(2)
  })

  it('is a no-op (returns 0, never enqueues) when nothing is stuck', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const queue = {
      getJobState: vi.fn(),
      removeJob: vi.fn(),
      enqueue: vi.fn(),
    }
    const repo = fakeRepo(1)
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      repo as never,
      fakeConfig(300_000, 900_000),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(repo.bumpReconcileAttempts).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })

  it('evicts a residual `failed` job (removeOnFail-retained) before re-enqueueing', async () => {
    const rows = [{ tenant_id: 't1', id: 'i1' }]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = {
      getJobState: vi.fn().mockResolvedValue('failed'),
      removeJob: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
    }
    const repo = fakeRepo(1)
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      repo as never,
      fakeConfig(300_000, 900_000),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.removeJob).toHaveBeenCalledWith('i1')
    expect(queue.enqueue).toHaveBeenCalledWith('t1', 'i1')
    expect(repo.bumpReconcileAttempts).toHaveBeenCalledWith('t1', 'i1')
    expect(n).toBe(1)
  })

  it.each(['waiting', 'active', 'delayed', 'completed'])(
    'never duplicates a still-live job (state: %s) — no eviction, no re-enqueue, no attempt bump',
    async (state) => {
      const rows = [{ tenant_id: 't1', id: 'i1' }]
      const pool = { query: vi.fn().mockResolvedValue({ rows }) }
      const queue = {
        getJobState: vi.fn().mockResolvedValue(state),
        removeJob: vi.fn(),
        enqueue: vi.fn(),
      }
      const repo = fakeRepo(1)
      const service = new InvoiceReconciliationService(
        pool as never,
        queue as never,
        repo as never,
        fakeConfig(300_000, 900_000),
      )

      const n = await service.sweepStuckGeneration()

      expect(queue.removeJob).not.toHaveBeenCalled()
      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(repo.bumpReconcileAttempts).not.toHaveBeenCalled()
      expect(n).toBe(0)
    },
  )

  it('re-enqueues while attempts stay within the cap', async () => {
    const rows = [{ tenant_id: 't1', id: 'i1' }]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = {
      getJobState: vi.fn().mockResolvedValue(undefined),
      removeJob: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(undefined),
    }
    const repo = fakeRepo(5) // == cap, still <= cap → re-enqueue
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      repo as never,
      fakeConfig(300_000, 900_000, 5),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.enqueue).toHaveBeenCalledWith('t1', 'i1')
    expect(repo.markGenerationStatus).not.toHaveBeenCalled()
    expect(repo.recordDeadLetter).not.toHaveBeenCalled()
    expect(n).toBe(1)
  })

  it('dead-letters and neutralizes a poison invoice once attempts exceed the cap (no re-enqueue)', async () => {
    const rows = [{ tenant_id: 't1', id: 'i1' }]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = {
      getJobState: vi.fn().mockResolvedValue(undefined),
      removeJob: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(undefined),
    }
    const repo = fakeRepo(6) // > cap (5)
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      repo as never,
      fakeConfig(300_000, 900_000, 5),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(repo.markGenerationStatus).toHaveBeenCalledWith('t1', 'i1', 'failed')
    expect(repo.recordDeadLetter).toHaveBeenCalledWith(
      't1',
      'i1',
      'generation attempts cap exceeded',
      6,
    )
    expect(n).toBe(0) // ne compte pas comme un ré-enfilement
  })

  it('evicting a failed job and then exceeding the cap dead-letters without re-enqueueing', async () => {
    const rows = [{ tenant_id: 't1', id: 'i1' }]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = {
      getJobState: vi.fn().mockResolvedValue('failed'),
      removeJob: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
    }
    const repo = fakeRepo(3)
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      repo as never,
      fakeConfig(300_000, 900_000, 2),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.removeJob).toHaveBeenCalledWith('i1')
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(repo.markGenerationStatus).toHaveBeenCalledWith('t1', 'i1', 'failed')
    expect(repo.recordDeadLetter).toHaveBeenCalledWith(
      't1',
      'i1',
      'generation attempts cap exceeded',
      3,
    )
    expect(n).toBe(0)
  })
})
