import { describe, expect, it, vi } from 'vitest'
import { MaintenanceProcessor } from '../../src/worker/maintenance.processor.js'

function build() {
  const reconciliation = {
    sweepStuckGeneration: vi.fn().mockResolvedValue(3),
  }
  const sessionMaintenance = {
    purgeExpiredSessions: vi.fn().mockResolvedValue(2),
  }
  const archiveRetry = {
    sweepFailedArchives: vi.fn().mockResolvedValue(1),
  }
  const ereportingSweep = {
    sweep: vi.fn().mockResolvedValue(4),
  }
  const annuaireSweep = {
    sweepSync: vi.fn().mockResolvedValue(5),
    sweepStuckDrafts: vi.fn().mockResolvedValue(6),
  }
  const cdvSweep = {
    sweep: vi.fn().mockResolvedValue(7),
  }
  const cdvStuckRetry = {
    retryParked: vi.fn().mockResolvedValue(8),
  }
  const processor = new MaintenanceProcessor(
    reconciliation as never,
    sessionMaintenance as never,
    archiveRetry as never,
    ereportingSweep as never,
    annuaireSweep as never,
    cdvSweep as never,
    cdvStuckRetry as never,
  )
  return {
    processor,
    reconciliation,
    sessionMaintenance,
    archiveRetry,
    ereportingSweep,
    annuaireSweep,
    cdvSweep,
    cdvStuckRetry,
  }
}

describe('MaintenanceProcessor.process', () => {
  it('dispatches reconcile-invoices jobs to the reconciliation service', async () => {
    const { processor, reconciliation, sessionMaintenance } = build()

    await processor.process({ name: 'reconcile-invoices' } as never)

    expect(reconciliation.sweepStuckGeneration).toHaveBeenCalledTimes(1)
    expect(sessionMaintenance.purgeExpiredSessions).not.toHaveBeenCalled()
  })

  it('dispatches purge-sessions jobs to the session maintenance service (Task 7)', async () => {
    const { processor, reconciliation, sessionMaintenance } = build()

    await processor.process({ name: 'purge-sessions' } as never)

    expect(sessionMaintenance.purgeExpiredSessions).toHaveBeenCalledTimes(1)
    expect(reconciliation.sweepStuckGeneration).not.toHaveBeenCalled()
  })

  it('dispatches archive-retry jobs to the archive retry service (Task 8)', async () => {
    const { processor, reconciliation, sessionMaintenance, archiveRetry } =
      build()

    await processor.process({ name: 'archive-retry' } as never)

    expect(archiveRetry.sweepFailedArchives).toHaveBeenCalledTimes(1)
    expect(reconciliation.sweepStuckGeneration).not.toHaveBeenCalled()
    expect(sessionMaintenance.purgeExpiredSessions).not.toHaveBeenCalled()
  })

  it('dispatches ereporting-sweep jobs to the e-reporting sweep service (Task 7)', async () => {
    const {
      processor,
      reconciliation,
      sessionMaintenance,
      archiveRetry,
      ereportingSweep,
    } = build()

    await processor.process({ name: 'ereporting-sweep' } as never)

    expect(ereportingSweep.sweep).toHaveBeenCalledTimes(1)
    expect(reconciliation.sweepStuckGeneration).not.toHaveBeenCalled()
    expect(sessionMaintenance.purgeExpiredSessions).not.toHaveBeenCalled()
    expect(archiveRetry.sweepFailedArchives).not.toHaveBeenCalled()
  })

  it('dispatches annuaire-sync-diff jobs to the annuaire sweep service (TypeFlux=D, Task 9)', async () => {
    const { processor, annuaireSweep, ereportingSweep } = build()

    await processor.process({ name: 'annuaire-sync-diff' } as never)

    expect(annuaireSweep.sweepSync).toHaveBeenCalledTimes(1)
    expect(annuaireSweep.sweepSync).toHaveBeenCalledWith('D')
    expect(annuaireSweep.sweepStuckDrafts).not.toHaveBeenCalled()
    expect(ereportingSweep.sweep).not.toHaveBeenCalled()
  })

  it('dispatches annuaire-sync-full jobs to the annuaire sweep service (TypeFlux=C, Task 9)', async () => {
    const { processor, annuaireSweep } = build()

    await processor.process({ name: 'annuaire-sync-full' } as never)

    expect(annuaireSweep.sweepSync).toHaveBeenCalledTimes(1)
    expect(annuaireSweep.sweepSync).toHaveBeenCalledWith('C')
    expect(annuaireSweep.sweepStuckDrafts).not.toHaveBeenCalled()
  })

  it('dispatches annuaire-republish-sweep jobs to the annuaire sweep service (Task 9, injection revue STUCK-DRAFT)', async () => {
    const { processor, annuaireSweep } = build()

    await processor.process({ name: 'annuaire-republish-sweep' } as never)

    expect(annuaireSweep.sweepStuckDrafts).toHaveBeenCalledTimes(1)
    expect(annuaireSweep.sweepSync).not.toHaveBeenCalled()
  })

  it('dispatches cdv-transmission-sweep jobs to the cdv sweep service (Task 7)', async () => {
    const { processor, cdvSweep, cdvStuckRetry, ereportingSweep } = build()

    await processor.process({ name: 'cdv-transmission-sweep' } as never)

    expect(cdvSweep.sweep).toHaveBeenCalledTimes(1)
    expect(cdvStuckRetry.retryParked).not.toHaveBeenCalled()
    expect(ereportingSweep.sweep).not.toHaveBeenCalled()
  })

  it('dispatches cdv-stuck-retry jobs to the cdv stuck-retry service (Task 7)', async () => {
    const { processor, cdvSweep, cdvStuckRetry } = build()

    await processor.process({ name: 'cdv-stuck-retry' } as never)

    expect(cdvStuckRetry.retryParked).toHaveBeenCalledTimes(1)
    expect(cdvSweep.sweep).not.toHaveBeenCalled()
  })

  it('ignores a genuinely unknown job name without throwing (forward-compat)', async () => {
    const {
      processor,
      reconciliation,
      sessionMaintenance,
      archiveRetry,
      ereportingSweep,
      annuaireSweep,
      cdvSweep,
      cdvStuckRetry,
    } = build()

    await expect(
      processor.process({ name: 'some-future-job' } as never),
    ).resolves.toBeUndefined()
    expect(reconciliation.sweepStuckGeneration).not.toHaveBeenCalled()
    expect(sessionMaintenance.purgeExpiredSessions).not.toHaveBeenCalled()
    expect(archiveRetry.sweepFailedArchives).not.toHaveBeenCalled()
    expect(ereportingSweep.sweep).not.toHaveBeenCalled()
    expect(annuaireSweep.sweepSync).not.toHaveBeenCalled()
    expect(annuaireSweep.sweepStuckDrafts).not.toHaveBeenCalled()
    expect(cdvSweep.sweep).not.toHaveBeenCalled()
    expect(cdvStuckRetry.retryParked).not.toHaveBeenCalled()
  })
})
