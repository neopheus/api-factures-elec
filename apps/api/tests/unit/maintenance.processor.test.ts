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
  const processor = new MaintenanceProcessor(
    reconciliation as never,
    sessionMaintenance as never,
    archiveRetry as never,
    ereportingSweep as never,
  )
  return {
    processor,
    reconciliation,
    sessionMaintenance,
    archiveRetry,
    ereportingSweep,
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

  it('ignores a genuinely unknown job name without throwing (forward-compat)', async () => {
    const {
      processor,
      reconciliation,
      sessionMaintenance,
      archiveRetry,
      ereportingSweep,
    } = build()

    await expect(
      processor.process({ name: 'some-future-job' } as never),
    ).resolves.toBeUndefined()
    expect(reconciliation.sweepStuckGeneration).not.toHaveBeenCalled()
    expect(sessionMaintenance.purgeExpiredSessions).not.toHaveBeenCalled()
    expect(archiveRetry.sweepFailedArchives).not.toHaveBeenCalled()
    expect(ereportingSweep.sweep).not.toHaveBeenCalled()
  })
})
