import type { ConfigService } from '@nestjs/config'
import type { DefaultJobOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'

// Politique de retry/rétention PARTAGÉE entre le producteur (QueueModule,
// enfilement à l'ingestion) et le consommateur (WorkerQueueModule, re-
// enfilement par la réconciliation, Task 3) : UNE SEULE source de vérité
// pour `defaultJobOptions` de la file `invoice-generation`. Sans ce partage,
// un job re-enfilé par le balayage de réconciliation (qui tourne dans le
// process worker, donc sur SA PROPRE déclaration `registerQueue`, cf.
// worker-queue.module.ts) hériterait silencieusement des défauts BullMQ nus
// (attempts: 1, aucun backoff) au lieu de la politique réelle — divergence
// dangereuse entre deux jobs pourtant identiques en substance.
export function invoiceGenerationJobOptions(
  config: ConfigService<EnvConfig, true>,
): DefaultJobOptions {
  return {
    attempts: config.get('GENERATION_JOB_ATTEMPTS', { infer: true }),
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 86_400, count: 1000 },
    removeOnFail: { age: 604_800 },
  }
}
