import { describe, expect, it, vi } from 'vitest'
import { EREPORTING_SWEEP_JOB } from '../../src/queue/maintenance.job.js'
import { EreportingScheduler } from '../../src/worker/ereporting.scheduler.js'

function fakeConfig(everyMs: number) {
  return { get: () => everyMs } as never
}

describe('EreportingScheduler.onApplicationBootstrap', () => {
  it('upserts the repeatable scheduler with the configured cadence', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new EreportingScheduler(
      queue as never,
      fakeConfig(3_600_000),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'ereporting-sweep',
      { every: 3_600_000 },
      { name: EREPORTING_SWEEP_JOB },
    )
  })
})
