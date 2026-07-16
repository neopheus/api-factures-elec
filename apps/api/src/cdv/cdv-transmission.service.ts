import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { ConfigService } from '@nestjs/config'
// biome-ignore lint/style/useImportType: AnnuaireConsultationService est résolu par Nest via design:paramtypes.
import { AnnuaireConsultationService } from '../annuaire/annuaire-consultation.service.js'
import {
  AmbiguousResolutionError,
  RecipientUnaddressableError,
} from '../annuaire/ligne-adressage.js'
import {
  BuyerIdentifierMissingError,
  buildMailleFromBuyer,
  isoDateToYmd,
  normalizeToUndefined,
} from '../annuaire/maille-from-buyer.js'
import type { EnvConfig } from '../config/env.js'
// biome-ignore lint/style/useImportType: InvoicesRepository est résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import {
  type LifecycleStatus,
  STATUS_META,
} from '../invoices/lifecycle-status.js'
import {
  CDV_TRANSMISSION,
  type CdvTransmissionPort,
} from './cdv-transmission.port.js'
// biome-ignore lint/style/useImportType: CdvTransmissionRepository est résolu par Nest via design:paramtypes.
import {
  type CdvTarget,
  CdvTransmissionRepository,
} from './cdv-transmission.repository.js'
import { generateFlux6Cdar, validateFlux6Structure } from './flux6-cdar.js'

// Service d'ÉMISSION des CDV (Task 6, plan 3.1) : pour un évènement de
// statut obligatoire (facture, statut 200/210/212/213) déjà scellé (2.2), FAIT
// PROGRESSER indépendamment DEUX cibles (D6/D7 — succès partiel au grain
// facture×statut×cible) : `ppf` (toujours adressable, sans résolution) et
// `recipient` (résolu par l'annuaire 2.4). Assemble T1 (STATUS_META) + T2
// (génération/validation F6) + T3 (machine de livraison, consommée via
// isTerminal/assertTransition côté repository) + T4 (persistance idempotente)
// + T5 (port) + AnnuaireConsultationService.resolveRecipient (2.4) +
// InvoicesRepository.loadCanonical (2.1).

// Horodate de MESSAGE (MDT-8, AAAAMMJJHHMMSS, UTC) — même algorithme que
// `formatIssueDateTime` (ereporting-generation.service.ts), redéfini ICI
// plutôt qu'importé : le domaine de transmission CDV (`cdv/*`) ne dépend
// d'AUCUN module e-reporting (architecture, plan 3.1 — domaines séparés,
// précédent direct annuaire/ereporting). Pure, testable sur vecteurs fixes
// (aucun `Date.now()` caché — seul l'appelant, `transmitStatus` ci-dessous,
// capture l'horloge réelle).
export function formatMessageHorodate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

@Injectable()
export class CdvTransmissionService {
  private readonly logger = new Logger(CdvTransmissionService.name)
  private readonly paMatricule: string

  constructor(
    private readonly repo: CdvTransmissionRepository,
    private readonly annuaire: AnnuaireConsultationService,
    private readonly invoicesRepo: InvoicesRepository,
    @Inject(CDV_TRANSMISSION) private readonly port: CdvTransmissionPort,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.paMatricule = config.get('CDV_PA_MATRICULE', { infer: true })
  }

  // Émission au grain (facture, statut, cible) — D6/D7 : `ppf` et
  // `recipient` progressent INDÉPENDAMMENT (deux lignes distinctes,
  // insertTransmission/D8). `statusHorodate` est déjà formaté AAAAMMJJHHMMSS
  // par l'appelant (Task 7, A5 — dérivé de l'horodate SCELLÉ de l'évènement
  // de statut, `invoice_status_events.created_at`, 2.2) : ce service ne lit
  // JAMAIS le journal scellé lui-même (hors périmètre — Task 7/la SD
  // `find_cdv_transmissions_due` s'en chargent).
  async transmitStatus(
    tenantId: string,
    invoiceId: string,
    toStatus: LifecycleStatus,
    target: CdvTarget,
    statusHorodate: string,
  ): Promise<void> {
    // Idempotence (D8, 2ᵉ+3ᵉ couche) : une transmission déjà `transmitted`
    // OU TERMINALE (`acknowledged`/`rejected`) ne refait RIEN — ni
    // résolution annuaire, ni génération F6, ni appel port (miroir « à
    // blanc » EreportingGenerationService). `transmitted` N'EST PAS
    // terminal dans la machine (Task 3 — une transition future
    // transmitted->acknowledged/rejected reste possible via la FRONTIÈRE
    // D'ACQUITTEMENT, Task 8) mais NE DOIT PAS pour autant être retraité
    // ICI : seule cette frontière fait progresser un `transmitted`, jamais
    // un rejeu de `transmitStatus` — d'où le test explicite sur `resumable`
    // ET `status !== 'transmitted'` (le plan Step 1 le distingue
    // explicitement : « si terminal -> skip ; si transmitted -> skip ; si
    // parked -> ré-essayer la résolution »).
    const existing = await this.repo.findResumable(
      tenantId,
      invoiceId,
      toStatus,
      target,
    )
    if (
      existing &&
      (existing.status === 'transmitted' || !existing.resumable)
    ) {
      this.logger.debug(
        `cdv transmission ${existing.id} déjà ${existing.status} — skip`,
      )
      return
    }

    const invoice = await this.invoicesRepo.loadCanonical(tenantId, invoiceId)
    if (!invoice) {
      // Facture disparue entre l'enfilement (sweep, Task 7) et le
      // traitement — no-op idempotent (miroir EreportingGenerationService,
      // déclarant disparu). Rien de transitoire à rejouer.
      this.logger.warn(
        `cdv transmitStatus: invoice ${invoiceId} introuvable — no-op`,
      )
      return
    }

    // Cible `recipient` : résolution annuaire (D6) — la maille dérive du
    // `buyer` (A4). Cible `ppf` : AUCUNE résolution (matricule PPF interne,
    // toujours adressable, D7).
    let recipientMatricule: string | undefined
    if (target === 'recipient') {
      try {
        const maille = buildMailleFromBuyer(invoice.buyer)
        const dateYmd = isoDateToYmd(invoice.issueDate)
        recipientMatricule = (
          await this.annuaire.resolveRecipient(tenantId, maille, dateYmd)
        ).plateforme
      } catch (err) {
        if (
          err instanceof RecipientUnaddressableError ||
          err instanceof AmbiguousResolutionError ||
          err instanceof BuyerIdentifierMissingError
        ) {
          if (existing?.status === 'parked') {
            // Reprise (Task 7) toujours infructueuse — reste `parked`, PAS
            // un nouveau markParked (hors ALLOWED, Task 3 : `parked` ne se
            // re-« parke » jamais) : simple no-op journalisé.
            this.logger.debug(
              `cdv transmission ${existing.id} toujours non résolue (${err.message}) — reste parked`,
            )
            return
          }
          const { id } =
            existing ??
            (await this.repo.insertTransmission(tenantId, {
              invoiceId,
              toStatus,
              target,
              statusHorodate,
            }))
          try {
            await this.repo.markParked(tenantId, id, err.message)
          } catch (parkErr) {
            // CAS périmé (concurrence rare, miroir markTransmitted
            // ci-dessous) : déjà transitionnée par un traitement concurrent
            // — pas un échec, no-op.
            this.logger.warn(
              `cdv transmission ${id}: markParked CAS périmé (déjà transitionnée par un concurrent) — ${(parkErr as Error).message}`,
            )
          }
          return
        }
        // Erreur non typée (ex. panne annuaire/DB) : erreur OPÉRATIONNELLE,
        // PROPAGÉE (throw -> retry BullMQ, Task 7) — jamais absorbée en
        // parked (D8 : ne park QUE sur non-adressabilité/ambiguïté typée).
        throw err
      }
    }

    const xml = generateFlux6Cdar({
      senderMatricule: this.paMatricule,
      invoiceRef: invoice.number,
      statusCode: STATUS_META[toStatus].code,
      statusHorodate,
      messageHorodate: formatMessageHorodate(new Date()),
      issuer: normalizeToUndefined(invoice.seller.siren),
      recipient: normalizeToUndefined(invoice.buyer.siren),
    })
    const validation = validateFlux6Structure(xml)

    const { id } = await this.repo.insertTransmission(tenantId, {
      invoiceId,
      toStatus,
      target,
      statusHorodate,
      xml,
      recipientMatricule,
    })

    if (!validation.valid) {
      // F6 structurellement invalide (bug de génération local — NOUS
      // générons ce F6) : born-rejetée, PAS d'appel port (miroir 2.3-T8 XSD
      // invalide -> REJ_SEMAN). `from` = l'état courant réel de la ligne
      // (genèse fraîche 'prepared' si `existing` était `null`, sinon l'état
      // rechargé par `findResumable` ci-dessus — 'prepared' ou 'parked').
      const from = existing?.status ?? 'prepared'
      await this.repo.appendStatusEvent(
        tenantId,
        id,
        from,
        'rejected',
        'platform',
        'f6-invalide',
      )
      this.logger.warn(
        `cdv transmission ${id} born-rejetée (f6-invalide) : ${validation.errors}`,
      )
      return
    }

    // Erreur de transport/outillage (port) : OPÉRATIONNELLE, PROPAGÉE
    // (throw -> retry BullMQ, Task 7/CDV_TRANSMISSION_JOB_ATTEMPTS) —
    // jamais absorbée ici, contrairement au CAS périmé de markTransmitted
    // ci-dessous.
    const result = await this.port.transmit({
      tenantId,
      invoiceId,
      toStatus,
      target,
      xml,
    })
    try {
      // Injection revue T6 (F1/F2, BINDING — cf. bannière markTransmitted,
      // cdv-transmission.repository.ts) : `xml`/`recipientMatricule` sont
      // TOUJOURS transmis ici, pas seulement en reprise — un envoi FRESH les
      // réécrit avec la MÊME valeur déjà posée par `insertTransmission`
      // ci-dessus (no-op idempotent), une REPRISE (parked→transmitted) les
      // PERSISTE enfin (l'appel `insertTransmission` de la reprise, plus
      // haut, est un no-op de conflit qui ne réécrit jamais ces colonnes).
      await this.repo.markTransmitted(tenantId, id, result.trackingRef, {
        xml,
        recipientMatricule,
      })
    } catch (err) {
      // CAS périmé (miroir EreportingGenerationService.generate) : déjà
      // marquée `transmitted` par un traitement concurrent — pas un échec,
      // no-op.
      this.logger.warn(
        `cdv transmission ${id}: markTransmitted CAS périmé (déjà traité par un concurrent) — ${(err as Error).message}`,
      )
    }
  }
}
