import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MetricsService } from '../../src/metrics/metrics.service.js'
import { PgPoolMetricsService } from '../../src/metrics/pg-pool-metrics.service.js'

describe('PgPoolMetricsService', () => {
  let metrics: MetricsService
  let pool: pg.Pool
  let service: PgPoolMetricsService

  beforeEach(() => {
    metrics = new MetricsService()
    pool = {
      totalCount: 7,
      idleCount: 4,
      waitingCount: 1,
    } as unknown as pg.Pool
    service = new PgPoolMetricsService(metrics, pool)
  })

  it('onModuleInit enregistre un collector sur MetricsService', () => {
    const registerSpy = vi.spyOn(metrics, 'registerCollector')

    service.onModuleInit()

    expect(registerSpy).toHaveBeenCalledTimes(1)
  })

  it('collect() pose pg_pool{state="total"|"idle"|"waiting"} depuis pool.totalCount/idleCount/waitingCount', async () => {
    await service.collect()
    const text = await metrics.render()

    expect(text).toContain('pg_pool{state="total"} 7')
    expect(text).toContain('pg_pool{state="idle"} 4')
    expect(text).toContain('pg_pool{state="waiting"} 1')
  })

  it('collecte au scrape : les valeurs reflètent l’état COURANT du pool, pas un instantané figé à la construction', async () => {
    service.onModuleInit()
    ;(pool as unknown as { totalCount: number }).totalCount = 9
    ;(pool as unknown as { idleCount: number }).idleCount = 2
    ;(pool as unknown as { waitingCount: number }).waitingCount = 0

    const text = await metrics.render()

    expect(text).toContain('pg_pool{state="total"} 9')
    expect(text).toContain('pg_pool{state="idle"} 2')
    expect(text).toContain('pg_pool{state="waiting"} 0')
  })
})
