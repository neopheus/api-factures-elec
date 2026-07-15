import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { RECONCILE_INVOICES_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas
// le planificateur) — même motif que le futur planificateur de purge des
// sessions (Task 7). Une clé de planificateur DÉDIÉE ('invoice-
// reconciliation', distincte de 'session-purge') : upsertJobScheduler est
// identifié par sa clé, pas par la file — les deux peuvent coexister sur
// `maintenance` sans collision.
@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('RECONCILIATION_SWEEP_EVERY_MS', {
      infer: true,
    })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'invoice-reconciliation',
      { every: this.everyMs },
      { name: RECONCILE_INVOICES_JOB },
    )
  }
}
