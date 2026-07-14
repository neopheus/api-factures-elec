import { describe, expect, it, vi } from 'vitest'
import { InvoiceReconciliationService } from '../../src/worker/invoice-reconciliation.service.js'

function fakeConfig(staleMs: number, generatingStaleMs: number) {
  return {
    get: (key: string) =>
      key === 'RECONCILIATION_STALE_MS' ? staleMs : generatingStaleMs,
  } as never
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
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
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
    expect(n).toBe(2)
  })

  it('is a no-op (returns 0, never enqueues) when nothing is stuck', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const queue = {
      getJobState: vi.fn(),
      removeJob: vi.fn(),
      enqueue: vi.fn(),
    }
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      fakeConfig(300_000, 900_000),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.enqueue).not.toHaveBeenCalled()
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
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      fakeConfig(300_000, 900_000),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.removeJob).toHaveBeenCalledWith('i1')
    expect(queue.enqueue).toHaveBeenCalledWith('t1', 'i1')
    expect(n).toBe(1)
  })

  it.each([
    'waiting',
    'active',
    'delayed',
    'completed',
  ])('never duplicates a still-live job (state: %s) — no eviction, no re-enqueue', async (state) => {
    const rows = [{ tenant_id: 't1', id: 'i1' }]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = {
      getJobState: vi.fn().mockResolvedValue(state),
      removeJob: vi.fn(),
      enqueue: vi.fn(),
    }
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      fakeConfig(300_000, 900_000),
    )

    const n = await service.sweepStuckGeneration()

    expect(queue.removeJob).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })
})
