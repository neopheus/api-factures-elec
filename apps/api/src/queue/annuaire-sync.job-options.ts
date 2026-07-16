import type { ConfigService } from '@nestjs/config'
import type { DefaultJobOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'

// Politique de retry/rétention de la file `annuaire-sync` (Task 9) — motif
// partagé avec ereporting-generation.job-options.ts : SEULE source de
// vérité pour `defaultJobOptions`, appliquée par `registerQueueAsync`
// (worker-queue.module.ts). Couvre LES DEUX job.name de cette file
// (ANNUAIRE_SYNC_JOB : ingestion F14 ; ANNUAIRE_REPUBLISH_JOB : reprise de
// draft figé) : un `throw` OPÉRATIONNEL de l'un ou l'autre
// (AnnuaireXsdToolingError, échec DB/port transitoire) DOIT pouvoir être
// rejoué — sans `attempts` explicite ici, BullMQ appliquerait son défaut nu
// (1 tentative, aucun retry).
export function annuaireSyncJobOptions(
  config: ConfigService<EnvConfig, true>,
): DefaultJobOptions {
  return {
    attempts: config.get('ANNUAIRE_PUBLISH_JOB_ATTEMPTS', { infer: true }),
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 86_400, count: 1000 },
    removeOnFail: { age: 604_800 },
  }
}
