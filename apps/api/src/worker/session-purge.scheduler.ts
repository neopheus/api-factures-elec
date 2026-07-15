import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { PURGE_SESSIONS_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas
// le planificateur) — même motif que ReconciliationScheduler. Une clé de
// planificateur DÉDIÉE ('session-purge', distincte de
// 'invoice-reconciliation') : upsertJobScheduler est identifié par sa clé,
// pas par la file — les deux coexistent sur `maintenance` sans collision, et
// c'est bien MaintenanceProcessor (processor unique) qui route ensuite par
// `job.name`.
@Injectable()
export class SessionPurgeScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('SESSION_PURGE_EVERY_MS', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'session-purge',
      { every: this.everyMs },
      { name: PURGE_SESSIONS_JOB },
    )
  }
}
