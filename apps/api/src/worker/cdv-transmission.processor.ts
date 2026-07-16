import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
// biome-ignore lint/style/useImportType: CdvTransmissionService résolu par Nest via design:paramtypes.
import { CdvTransmissionService } from '../cdv/cdv-transmission.service.js'
import type { CdvTransmissionJob } from '../queue/cdv-transmission.job.js'
import { CDV_TRANSMISSION_QUEUE } from '../queue/queue.constants.js'

// Processeur de la file `cdv-transmission` (Task 7) — UN SEUL type de job y
// transite (CDV_TRANSMISSION_JOB, posé par CdvTransmissionSweepService) : pas
// de routage par `job.name` nécessaire, motif EreportingGenerationProcessor.
// Toute la logique métier (résolution annuaire, génération/validation F6,
// persistance, transport) vit dans CdvTransmissionService.transmitStatus —
// ce processeur se contente de déléguer. Un throw éventuel (erreur
// opérationnelle : port transitoire, panne annuaire/DB) se propage tel quel
// pour déclencher un retry BullMQ (politique de la file,
// cdv-transmission.job-options.ts) ; un rejet FONCTIONNEL (parked,
// born-rejetée, 601) ne throw JAMAIS — `transmitStatus` retourne normalement.
@Processor(CDV_TRANSMISSION_QUEUE)
export class CdvTransmissionProcessor extends WorkerHost {
  constructor(private readonly service: CdvTransmissionService) {
    super()
  }

  async process(job: Job<CdvTransmissionJob>): Promise<void> {
    const { tenantId, invoiceId, toStatus, target, statusHorodate } = job.data
    await this.service.transmitStatus(
      tenantId,
      invoiceId,
      toStatus,
      target,
      statusHorodate,
    )
  }
}
