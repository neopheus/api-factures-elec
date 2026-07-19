import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { BILLING_USAGE_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (motif SessionPurgeScheduler) — clé de
// planificateur DÉDIÉE ('billing-usage', distincte des autres clés de la file
// `maintenance`) : upsertJobScheduler est identifié par sa clé, pas par la
// file — coexiste sans collision, et c'est bien MaintenanceProcessor
// (processor unique) qui route ensuite par `job.name`.
@Injectable()
export class BillingUsageScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('BILLING_USAGE_EVERY_MS', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'billing-usage',
      { every: this.everyMs },
      { name: BILLING_USAGE_JOB },
    )
  }
}
