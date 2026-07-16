import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
// biome-ignore lint/style/useImportType: AnnuairePublicationService résolu par Nest via design:paramtypes.
import { AnnuairePublicationService } from '../annuaire/annuaire-publication.service.js'
// biome-ignore lint/style/useImportType: AnnuaireSyncService résolu par Nest via design:paramtypes.
import { AnnuaireSyncService } from '../annuaire/annuaire-sync.service.js'
import {
  ANNUAIRE_REPUBLISH_JOB,
  ANNUAIRE_SYNC_JOB,
  type AnnuaireRepublishJob,
  type AnnuaireSyncJob,
} from '../queue/annuaire-sync.job.js'
import { ANNUAIRE_SYNC_QUEUE } from '../queue/queue.constants.js'

// Processeur UNIQUE de la file `annuaire-sync` (Task 9) — DEUX job.name y
// transitent (motif MaintenanceProcessor, jamais un second @Processor sur la
// même file) :
//  - ANNUAIRE_SYNC_JOB (posé par AnnuaireSweepService.sweepSync) : délègue à
//    AnnuaireSyncService.sync (pipeline fetchConsultation -> validation XSD +
//    parse -> upsert/remplacement du miroir, Task 9 Step 1) ;
//  - ANNUAIRE_REPUBLISH_JOB (posé par AnnuaireSweepService.sweepStuckDrafts,
//    injection revue contrôleur) : délègue à
//    AnnuairePublicationService.republishDraft (rejoue generate->validate->
//    port.publish->markPublished pour une ligne 'draft' figée).
// Un throw éventuel (AnnuaireXsdToolingError, échec DB/port transitoire) se
// propage tel quel pour déclencher un retry BullMQ (politique de la file,
// annuaire-sync.job-options.ts).
@Processor(ANNUAIRE_SYNC_QUEUE)
export class AnnuaireSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(AnnuaireSyncProcessor.name)

  constructor(
    private readonly syncService: AnnuaireSyncService,
    private readonly publicationService: AnnuairePublicationService,
  ) {
    super()
  }

  async process(
    job: Job<AnnuaireSyncJob | AnnuaireRepublishJob>,
  ): Promise<void> {
    if (job.name === ANNUAIRE_SYNC_JOB) {
      const { tenantId, typeFlux } = job.data as AnnuaireSyncJob
      await this.syncService.sync(tenantId, typeFlux)
      return
    }
    if (job.name === ANNUAIRE_REPUBLISH_JOB) {
      const { tenantId, ligneId } = job.data as AnnuaireRepublishJob
      await this.publicationService.republishDraft(tenantId, ligneId)
      return
    }
    this.logger.warn(`unknown annuaire-sync job: ${job.name}`)
  }
}
