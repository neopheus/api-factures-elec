import { describe, expect, it, vi } from 'vitest'
import { InvoiceGenerationProcessor } from '../../src/worker/invoice-generation.processor.js'

function job(data: { tenantId: string; invoiceId: string }) {
  return { data } as never
}

describe('InvoiceGenerationProcessor.process', () => {
  it('no-ops (idempotent) when the invoice vanished before generation', async () => {
    const repo = {
      loadCanonical: vi.fn().mockResolvedValue(null),
      markGenerationStatus: vi.fn(),
      completeGeneration: vi.fn(),
    }
    const generator = { generate: vi.fn() }
    const processor = new InvoiceGenerationProcessor(
      repo as never,
      generator as never,
    )

    await processor.process(job({ tenantId: 't', invoiceId: 'i' }))

    expect(repo.markGenerationStatus).not.toHaveBeenCalled()
    expect(generator.generate).not.toHaveBeenCalled()
    expect(repo.completeGeneration).not.toHaveBeenCalled()
  })

  it('marks generating, generates, then completes atomically on success', async () => {
    const invoice = { number: 'FA-1' }
    const formats = [{ kind: 'ubl' }]
    const repo = {
      loadCanonical: vi.fn().mockResolvedValue(invoice),
      markGenerationStatus: vi.fn().mockResolvedValue(undefined),
      completeGeneration: vi.fn().mockResolvedValue(undefined),
    }
    const generator = { generate: vi.fn().mockResolvedValue(formats) }
    const processor = new InvoiceGenerationProcessor(
      repo as never,
      generator as never,
    )

    await processor.process(job({ tenantId: 't', invoiceId: 'i' }))

    expect(repo.markGenerationStatus).toHaveBeenCalledWith(
      't',
      'i',
      'generating',
    )
    expect(generator.generate).toHaveBeenCalledWith(invoice)
    // Amendement A1 : UN SEUL appel atomique (pas de saveFormats séparé).
    expect(repo.completeGeneration).toHaveBeenCalledWith('t', 'i', formats)
    expect(repo.markGenerationStatus).toHaveBeenCalledTimes(1)
  })
})

describe('InvoiceGenerationProcessor.onFailed', () => {
  it('does nothing while retries remain (attemptsMade < attempts)', async () => {
    const repo = { markGenerationStatus: vi.fn() }
    const processor = new InvoiceGenerationProcessor(repo as never, {} as never)

    await processor.onFailed({
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { tenantId: 't', invoiceId: 'i' },
    } as never)

    expect(repo.markGenerationStatus).not.toHaveBeenCalled()
  })

  it('marks the invoice failed once attempts are exhausted', async () => {
    const repo = { markGenerationStatus: vi.fn().mockResolvedValue(undefined) }
    const processor = new InvoiceGenerationProcessor(repo as never, {} as never)

    await processor.onFailed({
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: { tenantId: 't', invoiceId: 'i' },
    } as never)

    expect(repo.markGenerationStatus).toHaveBeenCalledWith('t', 'i', 'failed')
  })

  it('defaults maxAttempts to 1 when job.opts.attempts is unset', async () => {
    const repo = { markGenerationStatus: vi.fn().mockResolvedValue(undefined) }
    const processor = new InvoiceGenerationProcessor(repo as never, {} as never)

    await processor.onFailed({
      attemptsMade: 1,
      opts: {},
      data: { tenantId: 't', invoiceId: 'i' },
    } as never)

    expect(repo.markGenerationStatus).toHaveBeenCalledWith('t', 'i', 'failed')
  })

  it('swallows a secondary failure while marking failed (logs, never throws)', async () => {
    const repo = {
      markGenerationStatus: vi.fn().mockRejectedValue(new Error('db down')),
    }
    const processor = new InvoiceGenerationProcessor(repo as never, {} as never)

    await expect(
      processor.onFailed({
        attemptsMade: 3,
        opts: { attempts: 3 },
        data: { tenantId: 't', invoiceId: 'i' },
      } as never),
    ).resolves.toBeUndefined()
  })
})
