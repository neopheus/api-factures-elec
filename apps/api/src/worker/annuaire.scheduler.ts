import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import {
  ANNUAIRE_REPUBLISH_SWEEP_JOB,
  ANNUAIRE_SYNC_DIFF_JOB,
  ANNUAIRE_SYNC_FULL_JOB,
} from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas
// le planificateur) — même motif que EreportingScheduler/ArchiveRetryScheduler
// /SessionPurgeScheduler/ReconciliationScheduler. TROIS clés de planificateur
// DÉDIÉES ('annuaire-sync-diff', 'annuaire-sync-full',
// 'annuaire-republish-sweep') : coexistent avec les planificateurs 2.1/2.2/
// 2.3 sur `maintenance` sans collision, c'est MaintenanceProcessor (processor
// unique) qui route ensuite par `job.name`.
@Injectable()
export class AnnuaireScheduler implements OnApplicationBootstrap {
  private readonly diffEveryMs: number
  private readonly fullEveryMs: number
  private readonly republishSweepEveryMs: number

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.diffEveryMs = config.get('ANNUAIRE_SYNC_EVERY_MS', { infer: true })
    this.fullEveryMs = config.get('ANNUAIRE_COMPLETE_EVERY_MS', {
      infer: true,
    })
    this.republishSweepEveryMs = config.get(
      'ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS',
      { infer: true },
    )
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'annuaire-sync-diff',
      { every: this.diffEveryMs },
      { name: ANNUAIRE_SYNC_DIFF_JOB },
    )
    await this.queue.upsertJobScheduler(
      'annuaire-sync-full',
      { every: this.fullEveryMs },
      { name: ANNUAIRE_SYNC_FULL_JOB },
    )
    await this.queue.upsertJobScheduler(
      'annuaire-republish-sweep',
      { every: this.republishSweepEveryMs },
      { name: ANNUAIRE_REPUBLISH_SWEEP_JOB },
    )
  }
}
