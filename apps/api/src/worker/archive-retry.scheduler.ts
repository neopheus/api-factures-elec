import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { ARCHIVE_RETRY_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas
// le planificateur) — même motif que SessionPurgeScheduler/
// ReconciliationScheduler. Une clé de planificateur DÉDIÉE
// ('archive-retry-scheduler', distincte de 'invoice-reconciliation' et
// 'session-purge') : les trois coexistent sur `maintenance` sans collision,
// c'est MaintenanceProcessor (processor unique) qui route ensuite par
// `job.name`.
@Injectable()
export class ArchiveRetryScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('ARCHIVE_RETRY_EVERY_MS', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'archive-retry-scheduler',
      { every: this.everyMs },
      { name: ARCHIVE_RETRY_JOB },
    )
  }
}
