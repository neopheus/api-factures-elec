import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type pg from 'pg'
import type { TypeFlux } from '../annuaire/nomenclature.js'
import { APP_POOL } from '../db/client.js'
import {
  ANNUAIRE_REPUBLISH_JOB,
  ANNUAIRE_SYNC_JOB,
  type AnnuaireRepublishJob,
  type AnnuaireSyncJob,
} from '../queue/annuaire-sync.job.js'
import { ANNUAIRE_SYNC_QUEUE } from '../queue/queue.constants.js'

interface SyncTargetRow {
  tenant_id: string
}

interface StaleDraftRow {
  tenant_id: string
  id: string
}

// Nombre max de drafts figés traités par passage (motif ArchiveRetryService
// .RETRY_BATCH — le sweep ne « rattrape » jamais un historique entier en un
// seul passage, discipline 2.3).
const STALE_DRAFT_BATCH = 100

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Bucket JOURNALIER (AAAAMMJJ, UTC) — fenêtre BORNÉE du sweep de sync
// (discipline 2.3-A2, plan Step 1) : contrairement à l'e-reporting (bucket =
// période due, `period.ts`), une sync annuaire n'a pas de notion de période
// métier — c'est le TEMPS CALENDAIRE qui borne les ré-enfilements. Deux
// sweeps successifs dans la MÊME journée UTC (scheduler qui double-tire,
// relance manuelle) produisent le MÊME jobId — BullMQ déduplique tant que le
// job précédent existe encore dans Redis (couche 2 de la défense en
// profondeur, cf. annuaire-sync.e2e.test.ts).
function todayBucket(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

// Ordonnanceur annuaire (Task 9, plan 2.4) — DEUX responsabilités distinctes
// partageant le même style de balayage (motif EreportingSweepService/
// ArchiveRetryService : requête directe sur APP_POOL, HORS contexte tenant,
// via une fonction SD cross-tenant SECURITY DEFINER — jamais via
// AnnuaireRepository, réservé aux opérations RLS scoped) :
//
//  1) `sweepSync` (plan Step 1) : énumère les tenants à synchroniser
//     (`find_annuaire_sync_targets`, migration 0019) puis enfile un job
//     `annuaire-sync` par tenant sur `ANNUAIRE_SYNC_QUEUE`, jobId
//     déterministe `${tenantId}:${typeFlux}:${bucket}` — 3 couches
//     anti-corruption/doublon (leçon 2.3, plan Step 1) : (a) fenêtre
//     bornée du bucket JOURNALIER ci-dessus, (b) jobId déterministe (dédup
//     BullMQ), (c) backstop DB (upsert idempotent / clé unique du miroir,
//     Task 5).
//
//  2) `sweepStuckDrafts` (injection revue contrôleur — STUCK-DRAFT
//     RE-PUBLISH SWEEP, fix du défaut T8 F1) : énumère les lignes 'draft'
//     figées depuis >15 min, TOUS tenants confondus
//     (`find_stale_annuaire_drafts`, migration 0020, miroir EXACT
//     `find_failed_archives`) puis enfile un job `annuaire-republish` par
//     ligne, jobId déterministe `${ligneId}-republish` — 3 couches
//     équivalentes : (a) gate de fraîcheur 15 min + BATCH borné côté SD,
//     (b) jobId déterministe, (c) idempotence PAR CONSTRUCTION du pipeline
//     rejoué (port write-once + CAS markPublished,
//     `AnnuairePublicationService.republishDraft`).
@Injectable()
export class AnnuaireSweepService {
  private readonly logger = new Logger(AnnuaireSweepService.name)

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    @InjectQueue(ANNUAIRE_SYNC_QUEUE)
    private readonly queue: Queue<AnnuaireSyncJob | AnnuaireRepublishJob>,
  ) {}

  // Renvoie le nombre de tenants traités — PAS le nombre de jobs BullMQ
  // réellement créés (déduplication par jobId possible, couche 2 ci-dessus ;
  // comportement voulu, pas une anomalie, motif EreportingSweepService).
  async sweepSync(typeFlux: TypeFlux): Promise<number> {
    const { rows } = await this.pool.query<SyncTargetRow>(
      'SELECT tenant_id FROM find_annuaire_sync_targets()',
    )
    const bucket = todayBucket()
    let processed = 0
    for (const row of rows) {
      const jobId = `${row.tenant_id}:${typeFlux}:${bucket}`
      await this.queue.add(
        ANNUAIRE_SYNC_JOB,
        { tenantId: row.tenant_id, typeFlux },
        { jobId },
      )
      processed++
    }
    if (processed > 0) {
      this.logger.log(
        `annuaire sync sweep (${typeFlux}) : ${processed} tenant job(s)`,
      )
    }
    return processed
  }

  // Renvoie le nombre de drafts figés re-enfilés (PAS le nombre de lignes
  // effectivement republiées — c'est `AnnuaireSyncProcessor`/
  // `republishDraft` qui l'accomplit de façon asynchrone, ce sweep ne fait
  // qu'énumérer + enfiler).
  async sweepStuckDrafts(): Promise<number> {
    const { rows } = await this.pool.query<StaleDraftRow>(
      'SELECT tenant_id, id FROM find_stale_annuaire_drafts($1)',
      [STALE_DRAFT_BATCH],
    )
    let processed = 0
    for (const row of rows) {
      const jobId = `${row.id}-republish`
      await this.queue.add(
        ANNUAIRE_REPUBLISH_JOB,
        { tenantId: row.tenant_id, ligneId: row.id },
        { jobId },
      )
      processed++
    }
    if (processed > 0) {
      this.logger.log(`annuaire stuck-draft sweep : ${processed} job(s)`)
    }
    return processed
  }
}
