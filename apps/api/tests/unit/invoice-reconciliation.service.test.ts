import { describe, expect, it, vi } from 'vitest'
import { InvoiceReconciliationService } from '../../src/worker/invoice-reconciliation.service.js'

function fakeConfig(staleMs: number) {
  return { get: () => staleMs } as never
}

describe('InvoiceReconciliationService.sweepStuckReceived', () => {
  it('queries stuck invoices with the configured staleness threshold, re-enqueues each', async () => {
    const rows = [
      { tenant_id: 't1', id: 'i1' },
      { tenant_id: 't2', id: 'i2' },
    ]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) }
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      fakeConfig(300_000),
    )

    const n = await service.sweepStuckReceived()

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id, id FROM find_stuck_received_invoices($1)',
      [300_000],
    )
    expect(queue.enqueue).toHaveBeenCalledWith('t1', 'i1')
    expect(queue.enqueue).toHaveBeenCalledWith('t2', 'i2')
    expect(queue.enqueue).toHaveBeenCalledTimes(2)
    expect(n).toBe(2)
  })

  it('is a no-op (returns 0, never enqueues) when nothing is stuck', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const queue = { enqueue: vi.fn() }
    const service = new InvoiceReconciliationService(
      pool as never,
      queue as never,
      fakeConfig(300_000),
    )

    const n = await service.sweepStuckReceived()

    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })
})
