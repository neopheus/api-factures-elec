import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { EREPORTING_SWEEP_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas
// le planificateur) — même motif que ArchiveRetryScheduler/
// SessionPurgeScheduler/ReconciliationScheduler. Une clé de planificateur
// DÉDIÉE ('ereporting-sweep', distincte de 'archive-retry-scheduler',
// 'session-purge' et 'invoice-reconciliation') : les quatre coexistent sur
// `maintenance` sans collision, c'est MaintenanceProcessor (processor
// unique) qui route ensuite par `job.name`.
@Injectable()
export class EreportingScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('EREPORTING_SWEEP_EVERY_MS', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'ereporting-sweep',
      { every: this.everyMs },
      { name: EREPORTING_SWEEP_JOB },
    )
  }
}
