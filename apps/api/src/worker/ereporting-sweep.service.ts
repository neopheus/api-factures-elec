import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
import type { FluxKind } from '../ereporting/ereporting.repository.js'
import type {
  IssuerRole,
  TransmissionType,
  VatRegime,
} from '../ereporting/nomenclature.js'
import { computeDuePeriods } from '../ereporting/period.js'
import {
  EREPORTING_GENERATE_JOB,
  type EreportingGenerationJob,
} from '../queue/ereporting-generation.job.js'
import { EREPORTING_GENERATION_QUEUE } from '../queue/queue.constants.js'

interface DueDeclarantRow {
  tenant_id: string
  id: string
  vat_regime: VatRegime
  role: IssuerRole
  siren: string
  name: string
}

// Le sweep n'enfile QUE des transactions initiales (fluxKind='transactions',
// type='IN') : le flux 'payments' (TB-3) est différé faute de source
// (D10) — jamais enfilé ici ; un rectificatif ('RE') est un flux distinct,
// hors périmètre de l'ordonnanceur automatique.
const FLUX_KIND: FluxKind = 'transactions'
const TRANSMISSION_TYPE: TransmissionType = 'IN'

// Ordonnanceur e-reporting Flux 10 (Task 7, plan 2.3). Requête directe sur
// APP_POOL (pas via EreportingRepository) pour `find_ereporting_declarants_
// due()` : ce SD cross-tenant tourne HORS contexte tenant, exactement comme
// `find_failed_archives` (ArchiveRetryService) et `find_stuck_generation_
// invoices` (InvoiceReconciliationService) — EreportingRepository est
// réservé aux opérations RLS scoped via `tenant.run`, jamais aux balayages
// cross-tenant. Pour CHAQUE déclarant actif, calcule les périodes échues
// (computeDuePeriods, period.ts — fenêtre BORNÉE, amendement A2-plan) et
// enfile un job `ereporting-generation` par période due.
//
// Défense en profondeur contre le double-envoi (3 couches — cf. brief Task
// 7 ; AUCUNE seule ne suffit, les trois ENSEMBLE oui) :
//  1) fenêtre BORNÉE dans period.ts (MAX_DUE_PERIODS) : le balayage horaire
//     ne peut JAMAIS ré-enfiler un historique entier, quelle que soit
//     l'ancienneté du dernier passage réussi ;
//  2) `jobId` DÉTERMINISTE `${declarantId}:${fluxKind}:${periodStart}` —
//     BullMQ déduplique par jobId tant que le job existe encore dans Redis
//     (vérifié empiriquement, cf. tests/e2e/ereporting-sweep.e2e.test.ts :
//     un ré-enfilement avec le même jobId ne crée PAS de second job) ;
//  3) backstop base de données : l'index unique partiel WHERE type='IN'
//     (migration 0016) + `insertTransmission` idempotent (Task 5) — si les
//     couches 1/2 laissaient malgré tout passer un doublon (ex. jobId
//     différent après un changement de fenêtre bornée), le worker (Task 8)
//     le détecterait au niveau DB et sauterait la période déjà transmise
//     au lieu de la ré-émettre au PPF.
@Injectable()
export class EreportingSweepService {
  private readonly logger = new Logger(EreportingSweepService.name)

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    @InjectQueue(EREPORTING_GENERATION_QUEUE)
    private readonly queue: Queue<EreportingGenerationJob>,
  ) {}

  // Renvoie le nombre de couples (déclarant, période due) traités — PAS le
  // nombre de jobs BullMQ réellement créés (la déduplication par jobId,
  // couche 2 ci-dessus, peut faire de certains appels des no-op côté Redis ;
  // c'est le comportement voulu, pas une anomalie à compter séparément).
  async sweep(): Promise<number> {
    const { rows } = await this.pool.query<DueDeclarantRow>(
      'SELECT tenant_id, id, vat_regime, role, siren, name FROM find_ereporting_declarants_due()',
    )
    const now = new Date()
    let processed = 0
    for (const row of rows) {
      const periods = computeDuePeriods(row.vat_regime, now)
      for (const period of periods) {
        const jobId = `${row.id}:${FLUX_KIND}:${period.periodStart}`
        await this.queue.add(
          EREPORTING_GENERATE_JOB,
          {
            tenantId: row.tenant_id,
            declarantId: row.id,
            siren: row.siren,
            role: row.role,
            fluxKind: FLUX_KIND,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            type: TRANSMISSION_TYPE,
          },
          { jobId },
        )
        processed++
      }
    }
    if (processed > 0) {
      this.logger.log(
        `ereporting sweep: ${processed} declarant×period job(s) processed`,
      )
    }
    return processed
  }
}
