import type { ConfigService } from '@nestjs/config'
import type { DefaultJobOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'

// Politique de retry/rétention de la file `cdv-transmission` (Task 7) —
// motif partagé avec ereporting-generation.job-options.ts/annuaire-sync.
// job-options.ts : SEULE source de vérité pour `defaultJobOptions`, appliquée
// par `registerQueueAsync` (worker-queue.module.ts — cette file n'a qu'un
// producteur, CdvTransmissionSweepService, ET qu'un consommateur,
// CdvTransmissionProcessor, tous deux dans le process worker). Un `throw` du
// processor — erreur OPÉRATIONNELLE (transport/outillage : port.transmit,
// panne annuaire/DB) — DOIT pouvoir être rejoué ; un rejet FONCTIONNEL
// (parked, born-rejetée f6-invalide, 601) ne throw JAMAIS (CdvTransmission
// Service.transmitStatus retourne normalement) et n'est donc jamais rejoué
// par cette politique — sans `attempts` explicite ici, BullMQ appliquerait
// son défaut nu (1 tentative, aucun retry), contredisant l'exigence
// « throw -> retry » pour les erreurs opérationnelles.
export function cdvTransmissionJobOptions(
  config: ConfigService<EnvConfig, true>,
): DefaultJobOptions {
  return {
    attempts: config.get('CDV_TRANSMISSION_JOB_ATTEMPTS', { infer: true }),
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 86_400, count: 1000 },
    removeOnFail: { age: 604_800 },
  }
}
