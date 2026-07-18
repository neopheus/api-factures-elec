import { describe, expect, it, vi } from 'vitest'
import { ROUTING_RETRY_JOB } from '../../src/queue/maintenance.job.js'
import { RoutingRetryScheduler } from '../../src/worker/routing-retry.scheduler.js'

function fakeConfig(everyMs: number) {
  return { get: () => everyMs } as never
}

describe('RoutingRetryScheduler.onApplicationBootstrap', () => {
  it('upserts the repeatable scheduler with the configured cadence (ROUTING_RETRY_EVERY_MS réellement consommée)', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new RoutingRetryScheduler(
      queue as never,
      fakeConfig(300_000),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'routing-retry-scheduler',
      { every: 300_000 },
      { name: ROUTING_RETRY_JOB },
    )
  })

  it('propage une cadence différente de la valeur par défaut', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new RoutingRetryScheduler(
      queue as never,
      fakeConfig(60_000),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'routing-retry-scheduler',
      { every: 60_000 },
      { name: ROUTING_RETRY_JOB },
    )
  })
})
