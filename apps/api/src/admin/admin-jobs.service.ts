import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import {
  ANNUAIRE_SYNC_QUEUE,
  CDV_TRANSMISSION_QUEUE,
  EREPORTING_GENERATION_QUEUE,
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../queue/queue.constants.js'
// biome-ignore lint/style/useImportType: AdminSupervisionRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminSupervisionRepository } from './admin-supervision.repository.js'

export interface RetryFailedResult {
  retried: number
  errors: number
}

// Relance admin des jobs échoués (Task 5, spec §3, POST /admin/jobs/:queue/
// retry) — allowlist STRICTE = EXACTEMENT les constantes de
// queue.constants.ts, matérialisée en Map figée nom public -> Queue injectée
// (construite une seule fois au constructeur). Un nom hors de cette Map
// retourne `null` immédiatement — AUCUNE requête Redis n'est tentée pour un
// nom arbitraire, contrairement à `new Queue(queueName, ...)` qui créerait
// silencieusement une file inexistante. 404 posé par le contrôleur, motif
// AdminController.tenantDetail (même garde `if (result === null) throw
// this.notFound()`).
//
// Les 5 files ci-dessous couvrent l'intégralité de queue.constants.ts au
// moment de cette tâche (Task 5) : toute NOUVELLE file ajoutée au fichier
// constants DOIT être injectée ici ET ajoutée à la Map, sous peine de rester
// invisible à la relance admin (404 permanent pour cette file).
@Injectable()
export class AdminJobsService {
  private readonly queues: ReadonlyMap<string, Queue>

  constructor(
    @InjectQueue(INVOICE_GENERATION_QUEUE) invoiceGeneration: Queue,
    @InjectQueue(MAINTENANCE_QUEUE) maintenance: Queue,
    @InjectQueue(EREPORTING_GENERATION_QUEUE) ereportingGeneration: Queue,
    @InjectQueue(ANNUAIRE_SYNC_QUEUE) annuaireSync: Queue,
    @InjectQueue(CDV_TRANSMISSION_QUEUE) cdvTransmission: Queue,
    private readonly supervision: AdminSupervisionRepository,
  ) {
    this.queues = new Map<string, Queue>([
      [INVOICE_GENERATION_QUEUE, invoiceGeneration],
      [MAINTENANCE_QUEUE, maintenance],
      [EREPORTING_GENERATION_QUEUE, ereportingGeneration],
      [ANNUAIRE_SYNC_QUEUE, annuaireSync],
      [CDV_TRANSMISSION_QUEUE, cdvTransmission],
    ])
  }

  // `null` = file hors allowlist (404 côté contrôleur). `limit` borne déjà
  // validée en amont par le contrôleur (zod, 1..500) — passée ici telle
  // quelle, `getFailed(0, limit - 1)` (BullMQ : plage INCLUSIVE des deux
  // bornes, donc `limit - 1` pour obtenir exactement `limit` jobs au plus).
  //
  // Isolation (spec §9, « job retry qui throw → compté non-relancé,
  // continue ») : `job.retry()` est appelé UN PAR UN dans un try/catch
  // dédié — un throw individuel est compté en erreur et NE STOPPE JAMAIS la
  // boucle (les jobs suivants restent tentés), motif
  // CdvStuckRetryService/ArchiveRetryService (rejeu best-effort borné,
  // jamais un Promise.all qui ferait échouer tout le lot pour UN job
  // fautif — un rejet BullMQ possible ici : le job a été supprimé/modifié
  // entre `getFailed` et `retry()` par un autre acteur concurrent).
  async retryFailed(
    queueName: string,
    adminId: string,
    limit: number,
  ): Promise<RetryFailedResult | null> {
    const queue = this.queues.get(queueName)
    if (!queue) return null

    const jobs = await queue.getFailed(0, limit - 1)
    let retried = 0
    let errors = 0
    for (const job of jobs) {
      try {
        await job.retry()
        retried++
      } catch {
        errors++
      }
    }

    // tenantId toujours `null` (spec §3) : une file BullMQ est une
    // ressource plateforme, jamais scopée à un tenant précis — même une
    // relance de `invoice-generation` (qui ne contient QUE des jobs
    // tenant-scopés en pratique) reste une action sur LA FILE, pas sur un
    // tenant identifié.
    await this.supervision.logAction(adminId, 'retry_jobs', null, {
      queue: queueName,
      retried,
      errors,
    })
    return { retried, errors }
  }
}
