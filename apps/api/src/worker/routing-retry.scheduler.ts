import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { ROUTING_RETRY_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (miroir ArchiveRetryScheduler). Clé de
// planificateur DÉDIÉE ('routing-retry-scheduler', distincte de
// 'archive-retry-scheduler' et des autres) : toutes coexistent sur
// `maintenance` sans collision, c'est MaintenanceProcessor (processor
// unique) qui route ensuite par `job.name`.
@Injectable()
export class RoutingRetryScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('ROUTING_RETRY_EVERY_MS', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'routing-retry-scheduler',
      { every: this.everyMs },
      { name: ROUTING_RETRY_JOB },
    )
  }
}
