import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type pg from 'pg'
import { dueSince, isPastDeadline } from '../cdv/cdv-deadline.js'
import type { CdvTarget } from '../cdv/cdv-transmission.repository.js'
import { formatMessageHorodate } from '../cdv/cdv-transmission.service.js'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL } from '../db/client.js'
import type { LifecycleStatus } from '../invoices/lifecycle-status.js'
import {
  CDV_TRANSMISSION_JOB,
  type CdvTransmissionJob,
} from '../queue/cdv-transmission.job.js'
import { CDV_TRANSMISSION_QUEUE } from '../queue/queue.constants.js'

interface DueCdvEventRow {
  tenant_id: string
  invoice_id: string
  to_status: LifecycleStatus
  status_created_at: Date
}

// Les DEUX cibles (D6/D7) — `ppf` (toujours adressable) et `recipient`
// (résolu par l'annuaire, 2.4) progressent INDÉPENDAMMENT (Task 6, succès
// partiel au grain facture×statut×cible) : le sweep enfile TOUJOURS les deux,
// jamais une résolution préalable ici (hors périmètre du sweep — c'est
// `CdvTransmissionService.transmitStatus`, Task 6, qui résout/parque).
const TARGETS: CdvTarget[] = ['ppf', 'recipient']

// Ordonnanceur CDV Flux 6 borné 24h (Task 7, plan 3.1, §3.6.6) — requête
// DIRECTE sur APP_POOL (pas via CdvTransmissionRepository) pour
// `find_cdv_transmissions_due()` : ce SD cross-tenant tourne HORS contexte
// tenant, exactement comme `find_ereporting_declarants_due`
// (EreportingSweepService, 2.3) / `find_failed_archives`
// (ArchiveRetryService, 2.2) — le repository reste réservé aux opérations
// RLS scoped via `tenant.run`, jamais aux balayages cross-tenant. Pour
// CHAQUE statut CDV FACTURE obligatoire dû (200/210/212/213, D7 — le SD
// exclut déjà les facultatifs), enfile un job `cdv-transmission` PAR cible
// (ppf, recipient).
//
// Défense en profondeur contre le double-envoi (3 couches — D8, motif
// EreportingSweepService/AnnuaireSweepService ; AUCUNE seule ne suffit, les
// trois ENSEMBLE oui) :
//  1) fenêtre BORNÉE `dueSince(now, CDV_TRANSMISSION_LOOKBACK_MS)`
//     (cdv-deadline.ts, amendement A5) : le balayage ne peut JAMAIS relire
//     tout le journal scellé `invoice_status_events`, quelle que soit
//     l'ancienneté du dernier passage réussi ;
//  2) `jobId` DÉTERMINISTE `${invoiceId}-${toStatus}-${target}` (séparateur
//     `-`, PAS `:` — leçon 2.4-T9) — BullMQ déduplique par jobId tant que le
//     job existe encore dans Redis ;
//  3) backstop base de données : l'index unique (invoice_id, to_status,
//     target) (migration 0021) + `insertTransmission` idempotent (Task 4) —
//     si les couches 1/2 laissaient malgré tout passer un doublon, le
//     worker (Task 6, `CdvTransmissionService.transmitStatus`) le détecterait
//     au niveau DB (`findResumable`) et sauterait la transmission déjà
//     terminale/`transmitted` au lieu de la ré-émettre.
@Injectable()
export class CdvTransmissionSweepService {
  private readonly logger = new Logger(CdvTransmissionSweepService.name)
  private readonly lookbackMs: number

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    @InjectQueue(CDV_TRANSMISSION_QUEUE)
    private readonly queue: Queue<CdvTransmissionJob>,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.lookbackMs = config.get('CDV_TRANSMISSION_LOOKBACK_MS', {
      infer: true,
    })
  }

  // Renvoie le nombre de couples (event, cible) traités — PAS le nombre de
  // jobs BullMQ réellement créés (la déduplication par jobId, couche 2
  // ci-dessus, peut faire de certains appels des no-op côté Redis ; c'est le
  // comportement voulu, motif EreportingSweepService).
  async sweep(): Promise<number> {
    const now = new Date()
    const since = dueSince(now, this.lookbackMs)
    const { rows } = await this.pool.query<DueCdvEventRow>(
      'SELECT tenant_id, invoice_id, to_status, status_created_at FROM find_cdv_transmissions_due($1)',
      [since],
    )
    let processed = 0
    for (const row of rows) {
      // Drapeau OBSERVATIONNEL (amendement A5/A6, cdv-deadline.ts) : un
      // dépassement du SLA 24h est journalisé, JAMAIS bloquant — le sweep
      // enfile la transmission normalement quel que soit le résultat.
      if (isPastDeadline(row.status_created_at, now)) {
        this.logger.warn(
          `cdv sweep: échéance 24h dépassée pour la facture ${row.invoice_id} (statut ${row.to_status} créé ${row.status_created_at.toISOString()})`,
        )
      }
      const statusHorodate = formatMessageHorodate(row.status_created_at)
      for (const target of TARGETS) {
        const jobId = `${row.invoice_id}-${row.to_status}-${target}`
        await this.queue.add(
          CDV_TRANSMISSION_JOB,
          {
            tenantId: row.tenant_id,
            invoiceId: row.invoice_id,
            toStatus: row.to_status,
            target,
            statusHorodate,
          },
          { jobId },
        )
        processed++
      }
    }
    if (processed > 0) {
      this.logger.log(`cdv sweep: ${processed} event×cible job(s) processed`)
    }
    return processed
  }
}
