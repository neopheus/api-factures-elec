import { describe, expect, it, vi } from 'vitest'
import { GENERATE_JOB } from '../../src/queue/invoice-generation.job.js'
import { InvoiceGenerationQueue } from '../../src/queue/invoice-generation.queue.js'

describe('InvoiceGenerationQueue.enqueue', () => {
  it('adds a job with jobId = invoiceId and a minimal id-only payload', async () => {
    const add = vi.fn().mockResolvedValue(undefined)
    const q = new InvoiceGenerationQueue({ add } as never)
    await q.enqueue('tenant-1', 'invoice-9')
    expect(add).toHaveBeenCalledWith(
      GENERATE_JOB,
      { tenantId: 'tenant-1', invoiceId: 'invoice-9' },
      { jobId: 'invoice-9' },
    )
  })

  it('never puts invoice content in the payload (ids only)', async () => {
    const add = vi.fn().mockResolvedValue(undefined)
    await new InvoiceGenerationQueue({ add } as never).enqueue('t', 'i')
    const payload = add.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['invoiceId', 'tenantId'])
  })
})
