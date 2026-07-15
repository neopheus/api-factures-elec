import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL } from '../db/client.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: InvoiceGenerationQueue résolu par Nest via design:paramtypes.
import { InvoiceGenerationQueue } from '../queue/invoice-generation.queue.js'

interface StuckInvoiceRow {
  tenant_id: string
  id: string
}

// Rattrape les factures bloquées sur DEUX statuts de génération, chacune
// pour une raison distincte :
// - `received` orpheline : l'enfilement Redis a échoué APRÈS la persistance
//   Postgres (cf. commentaire InvoicesService.ingest, "réconciliation
//   différée") — aucun job BullMQ ne référence jamais son id.
// - `generating` bloquée : le job a pu être définitivement `failed` (retries
//   épuisés) sans que l'écriture Postgres du statut `failed` n'ait abouti
//   (course `@OnWorkerEvent('failed')` vs `Worker.close()`, cf. rapport
//   Task 3) — la facture reste alors en `generating` indéfiniment alors que
//   Redis, lui, sait le job épuisé.
// Dans les deux cas, `find_stuck_generation_invoices` (SECURITY DEFINER,
// migration 0006) fait le tri par ancienneté (deux seuils distincts, cf.
// env.ts). Avant de ré-enfiler, on VÉRIFIE l'état du job existant :
// - `failed` (retenu par `removeOnFail`, 7 j) : il BLOQUERAIT le dédup
//   `jobId = invoiceId` d'un nouvel enfilement → on l'évince d'abord
//   (`removeJob`) puis on ré-enfile.
// - tout autre état existant (waiting/active/delayed/completed/...) : un job
//   VIVANT (ou déjà traité) existe déjà → NE JAMAIS le dupliquer, no-op pour
//   cette ligne (dédup voulu — la ligne a pu être capturée en fin de
//   traitement légitime, entre le balayage et sa lecture).
// - aucun job : ré-enfilement direct (orpheline classique).
@Injectable()
export class InvoiceReconciliationService {
  private readonly logger = new Logger(InvoiceReconciliationService.name)
  private readonly staleMs: number
  private readonly generatingStaleMs: number
  private readonly maxAttemptsCap: number

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly queue: InvoiceGenerationQueue,
    private readonly repo: InvoicesRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.staleMs = config.get('RECONCILIATION_STALE_MS', { infer: true })
    this.generatingStaleMs = config.get('RECONCILIATION_GENERATING_STALE_MS', {
      infer: true,
    })
    this.maxAttemptsCap = config.get('GENERATION_MAX_ATTEMPTS_CAP', {
      infer: true,
    })
  }

  // Task 8 : le ré-enfilement est désormais BORNÉ — une facture poison (qui
  // échoue systématiquement à sortir de `received`/`generating`) ne peut plus
  // boucler indéfiniment. Le compteur `reconcile_attempts` n'est incrémenté
  // QUE sur un vrai candidat au ré-enfilement (orpheline, ou job `failed`
  // évincé) — jamais quand un job vivant existe déjà (continue ci-dessus,
  // avant tout comptage). Au-delà du cap, la facture est neutralisée
  // (`failed` + entrée DLQ append-only) et ne sera plus jamais retournée par
  // `find_stuck_generation_invoices` (qui ignore les `failed`).
  async sweepStuckGeneration(): Promise<number> {
    const { rows } = await this.pool.query<StuckInvoiceRow>(
      'SELECT tenant_id, id FROM find_stuck_generation_invoices($1, $2)',
      [this.staleMs, this.generatingStaleMs],
    )
    let reenqueued = 0
    let deadLettered = 0
    for (const row of rows) {
      const state = await this.queue.getJobState(row.id)
      if (state === 'failed') {
        await this.queue.removeJob(row.id)
      } else if (state !== undefined) {
        // Job vivant (ou déjà traité) : dédup voulu, jamais de doublon —
        // ni comptage ni ré-enfilement.
        continue
      }
      // Candidat réel au ré-enfilement (orpheline ou job failed évincé).
      const attempts = await this.repo.bumpReconcileAttempts(
        row.tenant_id,
        row.id,
      )
      if (attempts > this.maxAttemptsCap) {
        // Poison : neutraliser définitivement — plus jamais ré-enfilée.
        await this.repo.markGenerationStatus(row.tenant_id, row.id, 'failed')
        await this.repo.recordDeadLetter(
          row.tenant_id,
          row.id,
          'generation attempts cap exceeded',
          attempts,
        )
        deadLettered++
        continue
      }
      await this.queue.enqueue(row.tenant_id, row.id)
      reenqueued++
    }
    if (reenqueued > 0 || deadLettered > 0) {
      this.logger.log(
        `reconciliation: ${reenqueued} re-enqueued, ${deadLettered} dead-lettered`,
      )
    }
    return reenqueued
  }
}
