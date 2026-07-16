import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import {
  CDV_STUCK_RETRY_JOB,
  CDV_TRANSMISSION_SWEEP_JOB,
} from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas
// le planificateur) — même motif que EreportingScheduler/AnnuaireScheduler.
// DEUX clés de planificateur DÉDIÉES ('cdv-transmission-sweep',
// 'cdv-stuck-retry') : coexistent avec les planificateurs 2.1/2.2/2.3/2.4
// sur `maintenance` sans collision, c'est MaintenanceProcessor (processor
// unique) qui route ensuite par `job.name`.
@Injectable()
export class CdvTransmissionScheduler implements OnApplicationBootstrap {
  private readonly sweepEveryMs: number
  private readonly stuckRetryEveryMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.sweepEveryMs = config.get('CDV_SWEEP_EVERY_MS', { infer: true })
    this.stuckRetryEveryMs = config.get('CDV_STUCK_RETRY_EVERY_MS', {
      infer: true,
    })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'cdv-transmission-sweep',
      { every: this.sweepEveryMs },
      { name: CDV_TRANSMISSION_SWEEP_JOB },
    )
    await this.queue.upsertJobScheduler(
      'cdv-stuck-retry',
      { every: this.stuckRetryEveryMs },
      { name: CDV_STUCK_RETRY_JOB },
    )
  }
}
