import { describe, expect, it } from 'vitest'
import { invoiceGenerationJobOptions } from '../../src/queue/invoice-generation.job-options.js'

function fakeConfig(attempts: number) {
  return { get: () => attempts } as never
}

describe('invoiceGenerationJobOptions', () => {
  it('reads attempts from GENERATION_JOB_ATTEMPTS and applies exponential backoff', () => {
    const opts = invoiceGenerationJobOptions(fakeConfig(5))
    expect(opts.attempts).toBe(5)
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 })
  })

  it('bounds retention (completed short-lived, failed kept longer for traceability)', () => {
    const opts = invoiceGenerationJobOptions(fakeConfig(3))
    expect(opts.removeOnComplete).toEqual({ age: 86_400, count: 1000 })
    expect(opts.removeOnFail).toEqual({ age: 604_800 })
  })
})
