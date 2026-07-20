import type { Queue } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminJobsService } from '../../src/admin/admin-jobs.service.js'
import type { AdminSupervisionRepository } from '../../src/admin/admin-supervision.repository.js'
import {
  ANNUAIRE_SYNC_QUEUE,
  CDV_TRANSMISSION_QUEUE,
  EREPORTING_GENERATION_QUEUE,
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'

// Task 5 (spec §3) : AdminJobsService — allowlist stricte (constantes de
// queue.constants.ts), isolation (un `job.retry()` qui throw ne bloque pas
// les suivants) et journalisation admin_actions déléguée à
// AdminSupervisionRepository.logAction (motif AdminService.test.ts : purs
// mocks jest, jamais de pool Postgres réel ici — la requête SQL elle-même
// est couverte par tests/e2e/admin-jobs-retry.e2e.test.ts, HEAVY).
describe('AdminJobsService', () => {
  let invoiceGeneration: { getFailed: ReturnType<typeof vi.fn> }
  let maintenance: { getFailed: ReturnType<typeof vi.fn> }
  let ereportingGeneration: { getFailed: ReturnType<typeof vi.fn> }
  let annuaireSync: { getFailed: ReturnType<typeof vi.fn> }
  let cdvTransmission: { getFailed: ReturnType<typeof vi.fn> }
  let supervision: { logAction: ReturnType<typeof vi.fn> }
  let service: AdminJobsService

  beforeEach(() => {
    invoiceGeneration = { getFailed: vi.fn().mockResolvedValue([]) }
    maintenance = { getFailed: vi.fn().mockResolvedValue([]) }
    ereportingGeneration = { getFailed: vi.fn().mockResolvedValue([]) }
    annuaireSync = { getFailed: vi.fn().mockResolvedValue([]) }
    cdvTransmission = { getFailed: vi.fn().mockResolvedValue([]) }
    supervision = { logAction: vi.fn().mockResolvedValue(undefined) }
    service = new AdminJobsService(
      invoiceGeneration as unknown as Queue,
      maintenance as unknown as Queue,
      ereportingGeneration as unknown as Queue,
      annuaireSync as unknown as Queue,
      cdvTransmission as unknown as Queue,
      supervision as unknown as AdminSupervisionRepository,
    )
  })

  it('returns null for a queue name outside the allowlist, WITHOUT touching any queue or the journal (controller turns null into 404)', async () => {
    const result = await service.retryFailed('not-a-real-queue', 'admin-1', 100)

    expect(result).toBeNull()
    expect(invoiceGeneration.getFailed).not.toHaveBeenCalled()
    expect(maintenance.getFailed).not.toHaveBeenCalled()
    expect(ereportingGeneration.getFailed).not.toHaveBeenCalled()
    expect(annuaireSync.getFailed).not.toHaveBeenCalled()
    expect(cdvTransmission.getFailed).not.toHaveBeenCalled()
    expect(supervision.logAction).not.toHaveBeenCalled()
  })

  it('passes (0, limit - 1) to Queue.getFailed (BullMQ range is inclusive)', async () => {
    await service.retryFailed(INVOICE_GENERATION_QUEUE, 'admin-1', 250)

    expect(invoiceGeneration.getFailed).toHaveBeenCalledWith(0, 249)
  })

  it('an empty queue returns { retried: 0, errors: 0 } and is still journalized', async () => {
    const result = await service.retryFailed(MAINTENANCE_QUEUE, 'admin-1', 100)

    expect(result).toEqual({ retried: 0, errors: 0 })
    expect(supervision.logAction).toHaveBeenCalledWith(
      'admin-1',
      'retry_jobs',
      null,
      { queue: MAINTENANCE_QUEUE, retried: 0, errors: 0 },
    )
  })

  it('isolation: a throwing job.retry() is counted as an error, WITHOUT aborting the remaining jobs', async () => {
    const job1 = { retry: vi.fn().mockRejectedValue(new Error('boom')) }
    const job2 = { retry: vi.fn().mockResolvedValue(undefined) }
    ereportingGeneration.getFailed.mockResolvedValue([job1, job2])

    const result = await service.retryFailed(
      EREPORTING_GENERATION_QUEUE,
      'admin-1',
      100,
    )

    expect(result).toEqual({ retried: 1, errors: 1 })
    expect(job1.retry).toHaveBeenCalledTimes(1)
    expect(job2.retry).toHaveBeenCalledTimes(1) // le 2e job est bien tenté malgré l'échec du 1er
    expect(supervision.logAction).toHaveBeenCalledWith(
      'admin-1',
      'retry_jobs',
      null,
      { queue: EREPORTING_GENERATION_QUEUE, retried: 1, errors: 1 },
    )
  })

  it('every allowlisted queue name is reachable (annuaire-sync, cdv-transmission included)', async () => {
    await service.retryFailed(ANNUAIRE_SYNC_QUEUE, 'admin-1', 5)
    expect(annuaireSync.getFailed).toHaveBeenCalledWith(0, 4)

    await service.retryFailed(CDV_TRANSMISSION_QUEUE, 'admin-1', 5)
    expect(cdvTransmission.getFailed).toHaveBeenCalledWith(0, 4)
  })
})
