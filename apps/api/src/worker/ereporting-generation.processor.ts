import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
// biome-ignore lint/style/useImportType: EreportingGenerationService résolu par Nest via design:paramtypes.
import { EreportingGenerationService } from '../ereporting/ereporting-generation.service.js'
import type { EreportingGenerationJob } from '../queue/ereporting-generation.job.js'
import { EREPORTING_GENERATION_QUEUE } from '../queue/queue.constants.js'

// Processeur de la file `ereporting-generation` (Task 8 — la file est
// enregistrée dès Task 7 côté producteur/sweep, cf. worker-queue.module.ts).
// Un SEUL type de job y transite (EREPORTING_GENERATE_JOB, posé par
// EreportingSweepService) : pas de routage par `job.name` nécessaire, motif
// InvoiceGenerationProcessor. Toute la logique métier (pipeline
// période->agrégat->XML validé->persistance->transmission) vit dans
// EreportingGenerationService — ce processeur se contente de déléguer, un
// throw éventuel (XsdToolingError, échec DB/port transitoire) se propage tel
// quel pour déclencher un retry BullMQ (politique de la file,
// ereporting-generation.job-options.ts).
@Processor(EREPORTING_GENERATION_QUEUE)
export class EreportingGenerationProcessor extends WorkerHost {
  constructor(private readonly service: EreportingGenerationService) {
    super()
  }

  async process(job: Job<EreportingGenerationJob>): Promise<void> {
    await this.service.generate(job.data)
  }
}
