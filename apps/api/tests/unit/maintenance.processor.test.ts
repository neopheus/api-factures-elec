import { describe, expect, it, vi } from 'vitest'
import { MaintenanceProcessor } from '../../src/worker/maintenance.processor.js'

describe('MaintenanceProcessor.process', () => {
  it('dispatches reconcile-invoices jobs to the reconciliation service', async () => {
    const reconciliation = {
      sweepStuckReceived: vi.fn().mockResolvedValue(3),
    }
    const processor = new MaintenanceProcessor(reconciliation as never)

    await processor.process({ name: 'reconcile-invoices' } as never)

    expect(reconciliation.sweepStuckReceived).toHaveBeenCalledTimes(1)
  })

  it('ignores an unknown job name without throwing (forward-compat, Task 7 will add a branch)', async () => {
    const reconciliation = { sweepStuckReceived: vi.fn() }
    const processor = new MaintenanceProcessor(reconciliation as never)

    await expect(
      processor.process({ name: 'purge-sessions' } as never),
    ).resolves.toBeUndefined()
    expect(reconciliation.sweepStuckReceived).not.toHaveBeenCalled()
  })
})
