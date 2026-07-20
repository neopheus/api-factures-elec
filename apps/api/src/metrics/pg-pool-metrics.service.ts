import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import type pg from 'pg'
import { Gauge } from 'prom-client'
import { APP_POOL } from '../db/client.js'
import { MetricsService } from './metrics.service.js'

// Jauge du pool pg applicatif (Task 9, spec §6) — total/idle/waiting =
// `pg.Pool#totalCount/idleCount/waitingCount` : de simples compteurs internes
// au pool (aucune requête SQL), coût nul au scrape. Motif QueueMetricsService
// : Gauge enregistré sur le registre DÉDIÉ de MetricsService, collecte
// déclenchée AU SCRAPE via `registerCollector`.
@Injectable()
export class PgPoolMetricsService implements OnModuleInit {
  private readonly gauge: Gauge<'state'>

  // @Inject() explicite sur les deux dépendances (motif BillingGuard/
  // ApiKeyGuard) : sans lui, SWC émet un ternaire design:paramtypes dont la
  // branche "false" n'est atteignable qu'en cas d'import circulaire cassé —
  // structurellement impossible ici, jamais couvrable par un test.
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
  ) {
    this.gauge = new Gauge({
      name: 'pg_pool',
      help: 'Taille du pool de connexions Postgres applicatif, par état',
      labelNames: ['state'],
      registers: [metrics.registry],
    })
  }

  onModuleInit(): void {
    this.metrics.registerCollector(() => this.collect())
  }

  async collect(): Promise<void> {
    this.gauge.set({ state: 'total' }, this.pool.totalCount)
    this.gauge.set({ state: 'idle' }, this.pool.idleCount)
    this.gauge.set({ state: 'waiting' }, this.pool.waitingCount)
  }
}
