import { describe, expect, it, vi } from 'vitest'
import { ARCHIVE_RETRY_JOB } from '../../src/queue/maintenance.job.js'
import { ArchiveRetryScheduler } from '../../src/worker/archive-retry.scheduler.js'

function fakeConfig(everyMs: number) {
  return { get: () => everyMs } as never
}

describe('ArchiveRetryScheduler.onApplicationBootstrap', () => {
  it('upserts the repeatable scheduler with the configured cadence', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new ArchiveRetryScheduler(
      queue as never,
      fakeConfig(300_000),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'archive-retry-scheduler',
      { every: 300_000 },
      { name: ARCHIVE_RETRY_JOB },
    )
  })
})
