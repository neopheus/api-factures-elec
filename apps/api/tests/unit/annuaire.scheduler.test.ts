import { describe, expect, it, vi } from 'vitest'
import {
  ANNUAIRE_REPUBLISH_SWEEP_JOB,
  ANNUAIRE_SYNC_DIFF_JOB,
  ANNUAIRE_SYNC_FULL_JOB,
} from '../../src/queue/maintenance.job.js'
import { AnnuaireScheduler } from '../../src/worker/annuaire.scheduler.js'

function fakeConfig(values: Record<string, number>) {
  return { get: (key: string) => values[key] } as never
}

describe('AnnuaireScheduler.onApplicationBootstrap', () => {
  it('upserts THREE repeatable schedulers (diff/full/republish-sweep) with dedicated keys', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new AnnuaireScheduler(
      queue as never,
      fakeConfig({
        ANNUAIRE_SYNC_EVERY_MS: 86_400_000,
        ANNUAIRE_COMPLETE_EVERY_MS: 604_800_000,
        ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS: 300_000,
      }),
    )

    await scheduler.onApplicationBootstrap()

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(3)
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'annuaire-sync-diff',
      { every: 86_400_000 },
      { name: ANNUAIRE_SYNC_DIFF_JOB },
    )
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'annuaire-sync-full',
      { every: 604_800_000 },
      { name: ANNUAIRE_SYNC_FULL_JOB },
    )
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'annuaire-republish-sweep',
      { every: 300_000 },
      { name: ANNUAIRE_REPUBLISH_SWEEP_JOB },
    )
  })
})
