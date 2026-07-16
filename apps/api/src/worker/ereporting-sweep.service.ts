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
import {
  computeDuePaymentPeriods,
  computeDuePeriods,
} from '../ereporting/period.js'
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

// Le sweep enfile désormais DEUX flux initiaux (type='IN') par déclarant dû,
// sur des cadences DISTINCTES (D6/D7, Task 8) : 'transactions' (TB-2,
// computeDuePeriods) ET 'payments' (TB-3, computeDuePaymentPeriods — la
// cadence PAIEMENT du Tableau 13 primaire, qui ne coïncide avec la cadence
// transactions que pour 3 régimes sur 4, cf. period.ts). Les deux passes sont
// indépendantes : un déclarant peut avoir des périodes transactions dues sans
// période paiement due, et réciproquement. Un rectificatif ('RE') est un flux
// distinct, hors périmètre de l'ordonnanceur automatique.
const TRANSACTIONS_FLUX_KIND: FluxKind = 'transactions'
const PAYMENTS_FLUX_KIND: FluxKind = 'payments'
const TRANSMISSION_TYPE: TransmissionType = 'IN'

// Ordonnanceur e-reporting Flux 10 (Task 7, plan 2.3 ; passe payments Task 8,
// plan 3.2). Requête directe sur APP_POOL (pas via EreportingRepository) pour
// `find_ereporting_declarants_due()` : ce SD cross-tenant tourne HORS
// contexte tenant, exactement comme `find_failed_archives`
// (ArchiveRetryService) et `find_stuck_generation_invoices`
// (InvoiceReconciliationService) — EreportingRepository est réservé aux
// opérations RLS scoped via `tenant.run`, jamais aux balayages cross-tenant.
// Pour CHAQUE déclarant actif, calcule séparément les périodes transactions
// échues (computeDuePeriods) ET les périodes paiement échues
// (computeDuePaymentPeriods) et enfile un job `ereporting-generation` par
// couple (déclarant, période due) de CHAQUE cadence — deux flux_kind
// disjoints, jamais mélangés dans le même job.
//
// Défense en profondeur contre le double-envoi (3 couches — cf. brief Task
// 7 ; AUCUNE seule ne suffit, les trois ENSEMBLE oui), IDENTIQUE pour les deux
// flux (D7) :
//  1) fenêtre BORNÉE dans period.ts (MAX_DUE_PERIODS, table de cadence
//     dédiée par flux) : le balayage horaire ne peut JAMAIS ré-enfiler un
//     historique entier, quelle que soit l'ancienneté du dernier passage
//     réussi ;
//  2) `jobId` DÉTERMINISTE — BullMQ déduplique par jobId tant que le job
//     existe encore dans Redis (vérifié empiriquement, cf.
//     tests/e2e/ereporting-sweep.e2e.test.ts : un ré-enfilement avec le même
//     jobId ne crée PAS de second job). Transactions : `${declarantId}:
//     ${fluxKind}:${periodStart}` (séparateur `:`, legacy pré-existant, dette
//     BullMQ post-5.80.5 hors périmètre). Payments : `${declarantId}-payments-
//     ${periodStart}` (séparateur `-`, leçon 2.4-T9 — JAMAIS `:` pour un flux
//     introduit après cette leçon) ;
//  3) backstop base de données : l'index unique partiel WHERE type='IN'
//     (migration 0016), clé sur `flux_kind` — un slot `payments` ne
//     collisionne JAMAIS avec un slot `transactions` du même déclarant/
//     période — + `insertTransmission` idempotent (Task 5) — si les couches
//     1/2 laissaient malgré tout passer un doublon (ex. jobId différent après
//     un changement de fenêtre bornée), le worker (Task 8) le détecterait au
//     niveau DB et sauterait la période déjà transmise au lieu de la
//     ré-émettre au PPF.
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
        const jobId = `${row.id}:${TRANSACTIONS_FLUX_KIND}:${period.periodStart}`
        await this.queue.add(
          EREPORTING_GENERATE_JOB,
          {
            tenantId: row.tenant_id,
            declarantId: row.id,
            siren: row.siren,
            role: row.role,
            fluxKind: TRANSACTIONS_FLUX_KIND,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            type: TRANSMISSION_TYPE,
          },
          { jobId },
        )
        processed++
      }

      const paymentPeriods = computeDuePaymentPeriods(row.vat_regime, now)
      for (const period of paymentPeriods) {
        const jobId = `${row.id}-${PAYMENTS_FLUX_KIND}-${period.periodStart}`
        await this.queue.add(
          EREPORTING_GENERATE_JOB,
          {
            tenantId: row.tenant_id,
            declarantId: row.id,
            siren: row.siren,
            role: row.role,
            fluxKind: PAYMENTS_FLUX_KIND,
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
