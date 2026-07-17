import type { ConfigService } from '@nestjs/config'
import type { DefaultJobOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'

// Politique de retry/rétention de la file `ereporting-generation` (Task 8).
// Motif partagé avec invoice-generation.job-options.ts : SEULE source de
// vérité pour `defaultJobOptions`, appliquée par `registerQueueAsync`
// (worker-queue.module.ts côté worker, queue.module.ts côté API — depuis le
// plan 3.4 Task 2, la file a DEUX producteurs : le sweep worker (IN) et
// l'endpoint HTTP de retransmission (RE) ; le consommateur reste unique,
// dans le process worker). Un `throw` du processeur
// (Task 8) — typiquement `XsdToolingError`, xmllint absent/erreur
// d'outillage, JAMAIS un rejet sémantique REJ_SEMAN qui, lui, retourne
// normalement — DOIT pouvoir être rejoué : sans `attempts` explicite ici,
// BullMQ appliquerait son défaut nu (1 tentative, aucun retry), contredisant
// l'exigence « throw -> retry » (injection Task 8 #6).
export function ereportingGenerationJobOptions(
  config: ConfigService<EnvConfig, true>,
): DefaultJobOptions {
  return {
    attempts: config.get('EREPORTING_GENERATION_JOB_ATTEMPTS', {
      infer: true,
    }),
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 86_400, count: 1000 },
    removeOnFail: { age: 604_800 },
  }
}
