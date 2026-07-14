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

describe('InvoiceGenerationQueue.getJobState', () => {
  it('returns undefined when no job exists for this id', async () => {
    const getJob = vi.fn().mockResolvedValue(undefined)
    const q = new InvoiceGenerationQueue({ getJob } as never)
    expect(await q.getJobState('missing')).toBeUndefined()
    expect(getJob).toHaveBeenCalledWith('missing')
  })

  it("returns the job's state when a job exists", async () => {
    const getState = vi.fn().mockResolvedValue('failed')
    const getJob = vi.fn().mockResolvedValue({ getState })
    const q = new InvoiceGenerationQueue({ getJob } as never)
    expect(await q.getJobState('i')).toBe('failed')
  })
})

describe('InvoiceGenerationQueue.removeJob', () => {
  it('removes the job by id (jobId = invoiceId)', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const q = new InvoiceGenerationQueue({ remove } as never)
    await q.removeJob('i')
    expect(remove).toHaveBeenCalledWith('i')
  })
})
