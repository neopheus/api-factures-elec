import { describe, expect, it, vi } from 'vitest'
import { PURGE_SESSIONS_JOB } from '../../src/queue/maintenance.job.js'
import { SessionPurgeScheduler } from '../../src/worker/session-purge.scheduler.js'

function fakeConfig(everyMs: number) {
  return { get: () => everyMs } as never
}

describe('SessionPurgeScheduler.onApplicationBootstrap', () => {
  it('upserts the repeatable scheduler with the configured cadence', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new SessionPurgeScheduler(
      queue as never,
      fakeConfig(3_600_000),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'session-purge',
      { every: 3_600_000 },
      { name: PURGE_SESSIONS_JOB },
    )
  })
})
