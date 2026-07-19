import type { Queue } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MetricsService } from '../../src/metrics/metrics.service.js'
import { QueueMetricsService } from '../../src/metrics/queue-metrics.service.js'
import {
  ANNUAIRE_SYNC_QUEUE,
  CDV_TRANSMISSION_QUEUE,
  EREPORTING_GENERATION_QUEUE,
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'

function fakeQueue(getJobCounts: ReturnType<typeof vi.fn>) {
  return { getJobCounts } as unknown as Queue
}

describe('QueueMetricsService', () => {
  let metrics: MetricsService
  let invoiceGeneration: ReturnType<typeof vi.fn>
  let maintenance: ReturnType<typeof vi.fn>
  let ereportingGeneration: ReturnType<typeof vi.fn>
  let annuaireSync: ReturnType<typeof vi.fn>
  let cdvTransmission: ReturnType<typeof vi.fn>
  let service: QueueMetricsService

  beforeEach(() => {
    metrics = new MetricsService()
    invoiceGeneration = vi.fn().mockResolvedValue({
      waiting: 3,
      active: 1,
      completed: 10,
      failed: 2,
      delayed: 0,
    })
    maintenance = vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    })
    ereportingGeneration = vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    })
    annuaireSync = vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    })
    cdvTransmission = vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    })
    service = new QueueMetricsService(
      metrics,
      fakeQueue(invoiceGeneration),
      fakeQueue(maintenance),
      fakeQueue(ereportingGeneration),
      fakeQueue(annuaireSync),
      fakeQueue(cdvTransmission),
    )
  })

  it('onModuleInit enregistre un collector sur MetricsService (motif registerCollector, Task 8)', async () => {
    const registerSpy = vi.spyOn(metrics, 'registerCollector')

    service.onModuleInit()

    expect(registerSpy).toHaveBeenCalledTimes(1)
  })

  it('collect() interroge getJobCounts SUR LES 5 ÉTATS explicites (waiting/active/completed/failed/delayed) pour CHACUNE des 5 files', async () => {
    await service.collect()

    for (const fn of [
      invoiceGeneration,
      maintenance,
      ereportingGeneration,
      annuaireSync,
      cdvTransmission,
    ]) {
      expect(fn).toHaveBeenCalledWith(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      )
    }
  })

  it('collect() pose bullmq_jobs{queue,state} avec les comptes retournés — visible dans render() (motif metrics.service.test.ts)', async () => {
    await service.collect()
    const text = await metrics.render()

    expect(text).toContain(
      `bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}",state="waiting"} 3`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}",state="active"} 1`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}",state="completed"} 10`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}",state="failed"} 2`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}",state="delayed"} 0`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${MAINTENANCE_QUEUE}",state="waiting"} 0`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${EREPORTING_GENERATION_QUEUE}",state="waiting"} 0`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${ANNUAIRE_SYNC_QUEUE}",state="waiting"} 0`,
    )
    expect(text).toContain(
      `bullmq_jobs{queue="${CDV_TRANSMISSION_QUEUE}",state="waiting"} 0`,
    )
  })

  it('isolation PAR FILE : une file dont getJobCounts() throw (Redis injoignable) n’empêche PAS la collecte des 4 autres, ne fait PAS throw collect()', async () => {
    maintenance.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(service.collect()).resolves.toBeUndefined()

    const text = await metrics.render()
    // La file en échec n'a jamais posé sa jauge (pas de faux 0 silencieux) :
    expect(text).not.toContain(`bullmq_jobs{queue="${MAINTENANCE_QUEUE}"`)
    // Les 4 autres sont bien collectées malgré l'échec de "maintenance" :
    expect(text).toContain(`bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}"`)
    expect(text).toContain(`bullmq_jobs{queue="${EREPORTING_GENERATION_QUEUE}"`)
    expect(text).toContain(`bullmq_jobs{queue="${ANNUAIRE_SYNC_QUEUE}"`)
    expect(text).toContain(`bullmq_jobs{queue="${CDV_TRANSMISSION_QUEUE}"`)
  })

  it('registerCollector(fn) exécuté au scrape déclenche bien collect() (bout en bout via MetricsService.render)', async () => {
    service.onModuleInit()

    const text = await metrics.render()

    expect(text).toContain(`bullmq_jobs{queue="${INVOICE_GENERATION_QUEUE}"`)
  })
})
