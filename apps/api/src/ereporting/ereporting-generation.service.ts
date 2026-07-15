import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import type { EreportingGenerationJob } from '../queue/ereporting-generation.job.js'
// biome-ignore lint/style/useImportType: EreportingRepository résolu par Nest via design:paramtypes.
import { EreportingRepository } from './ereporting.repository.js'
import { validateEreportingXml } from './ereporting-xsd-validator.js'
import {
  aggregateTransactions,
  classifyEreportingOperation,
} from './flux10-aggregate.js'
import type { Flux10Report } from './flux10-model.js'
import {
  FLUX10_TRANSMISSION,
  type Flux10TransmissionPort,
} from './flux10-transmission.port.js'
import { generateEreportingXml } from './flux10-xml.js'
import {
  SCHEME_ID_SIREN,
  SENDER_ROLE_PA,
  type TransmissionType,
} from './nomenclature.js'

// AAAAMMJJ (job/période, cf. period.ts) -> AAAA-MM-JJ (ISO, attendu par
// EreportingRepository.invoicesForPeriod, Task 5) — conversion EXPLICITE et
// TESTÉE (injection Task 8 #2, revue T5) : simple découpage de chaîne, le
// format d'entrée étant garanti par computeDuePeriods (period.ts). Exportée
// pour test direct (vecteurs fixes), comme les fonctions pures de period.ts.
export function periodDateToIso(aaaammjj: string): string {
  return `${aaaammjj.slice(0, 4)}-${aaaammjj.slice(4, 6)}-${aaaammjj.slice(6, 8)}`
}

// transmissionRef (TT-1, TB-1, injection Task 8 #7) : DÉTERMINISTE et ≤ 50
// caractères — sert d'identifiant de document (ReportDocument.Id) ET de clé
// write-once côté port (LocalFilesystemTransmissionStore, Task 6). Ne DOIT
// PAS dépendre de l'horloge : un rejeu (même déclarant/période/type) doit
// pouvoir régénérer EXACTEMENT le même ref. Borne structurelle : "ER-" (3) +
// 8 (préfixe declarantId) + "-" (1) + periodStart (8) + "-" (1) + type (2,
// IN|RE) = 23 caractères, toujours < 50 (TRANSMISSION_TYPES, nomenclature.ts).
export function buildTransmissionRef(
  declarantId: string,
  periodStart: string,
  type: TransmissionType,
): string {
  return `ER-${declarantId.slice(0, 8)}-${periodStart}-${type}`
}

// AAAAMMJJHHMMSS (TT-3, TG-1) — horodatage de CRÉATION de la transmission, en
// UTC (indépendant du fuseau de l'hôte worker). Prend `d: Date` en paramètre
// (comme computeDuePeriods prend `referenceDate`) : PAS de `Date.now()`
// caché, testable sur vecteurs fixes — seul l'appelant (generate ci-dessous)
// capture l'horloge réelle, au même titre que markTransmitted (Task 5) qui
// appelle directement `new Date()` pour `updatedAt`.
export function formatIssueDateTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

// Pipeline de génération e-reporting Flux 10 (Task 8 — tâche d'INTÉGRATION :
// tout ce que T1-T7 ont posé s'assemble ici). Par job {tenantId, declarantId,
// siren, role, fluxKind, periodStart, periodEnd, type} :
//   période -> factures (RLS) -> agrégat (10.3) -> Flux10Report -> XML
//   XSD-validé -> persistance idempotente -> transmission via le port ->
//   transmitted. À blanc (aucune opération 10.3) -> RIEN (D6).
@Injectable()
export class EreportingGenerationService {
  private readonly logger = new Logger(EreportingGenerationService.name)
  private readonly paId: string
  private readonly paSchemeId: string
  private readonly paName: string

  constructor(
    private readonly repo: EreportingRepository,
    @Inject(FLUX10_TRANSMISSION)
    private readonly port: Flux10TransmissionPort,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.paId = config.get('EREPORTING_PA_ID', { infer: true })
    this.paSchemeId = config.get('EREPORTING_PA_SCHEME_ID', { infer: true })
    this.paName = config.get('EREPORTING_PA_NAME', { infer: true })
  }

  async generate(job: EreportingGenerationJob): Promise<void> {
    // XOR TB-2/TB-3 par construction (injection Task 8 #3, revue T2
    // finding-2) : SEUL fluxKind='transactions' est jamais enfilé (D10,
    // EreportingSweepService) — l'agrégation des paiements est différée,
    // aucun chemin ne doit produire un Flux10Report avec `payments` non-null.
    // Garde défensive : un job 'payments' serait un bug ailleurs (jamais émis
    // par le sweep) — throw explicite (retry BullMQ, investigation requise)
    // plutôt qu'une mauvaise agrégation silencieuse en TB-2.
    if (job.fluxKind !== 'transactions') {
      throw new Error(
        `ereporting-generation: fluxKind '${job.fluxKind}' non pris en charge (agrégation paiements différée, D10) — ne devrait jamais être enfilé`,
      )
    }

    const startIso = periodDateToIso(job.periodStart)
    const endIso = periodDateToIso(job.periodEnd)
    const periodInvoices = await this.repo.invoicesForPeriod(
      job.tenantId,
      job.siren,
      job.role,
      startIso,
      endIso,
    )

    const transactionsReport = aggregateTransactions(periodInvoices, {
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
    })
    if (!transactionsReport) {
      // À blanc (D6, injection Task 8 #1) : ZÉRO écriture, ZÉRO appel port.
      return
    }

    const declarant = await this.repo.findDeclarant(
      job.tenantId,
      job.declarantId,
    )
    if (!declarant) {
      // Déclarant supprimé entre l'enfilement (sweep) et le traitement —
      // no-op idempotent (motif InvoiceGenerationProcessor : facture
      // disparue avant génération). Rien de transitoire à rejouer.
      this.logger.warn(
        `ereporting declarant ${job.declarantId} vanished before generation — no-op`,
      )
      return
    }

    const transmissionRef = buildTransmissionRef(
      job.declarantId,
      job.periodStart,
      job.type,
    )
    // TB-1 (injection Task 8 #7) : Sender = PA depuis env, Issuer = déclarant
    // (siren/role du PAYLOAD — recopiés par le sweep depuis la même ligne
    // ereporting_declarants au moment de l'enfilement ; name rechargé
    // ci-dessus, seul champ absent du payload minimal).
    const report: Flux10Report = {
      document: {
        id: transmissionRef,
        issueDateTime: formatIssueDateTime(new Date()),
        typeCode: job.type,
        sender: {
          id: this.paId,
          schemeId: this.paSchemeId,
          name: this.paName,
          roleCode: SENDER_ROLE_PA,
        },
        issuer: {
          id: job.siren,
          schemeId: SCHEME_ID_SIREN,
          name: declarant.name,
          roleCode: job.role,
        },
      },
      transactions: transactionsReport,
      payments: null,
    }

    const xml = generateEreportingXml(report)
    const invoiceCount = periodInvoices.filter(
      (invoice) => classifyEreportingOperation(invoice) === '10.3',
    ).length

    // Validation XSD DGFiP (injection Task 8 #6, plan Step 1.4) — helper PROD
    // (xmllint execFile async), PAS le helper de test. Note honnêteté (D9) :
    // XSD ≠ conformité sémantique complète (schematron/Annexe 7 différés) —
    // un flux XSD-valide peut encore être REJ_* par le PPF (Task 9).
    const validation = await validateEreportingXml(xml)

    if (!validation.valid) {
      // XML INVALIDE -> rejet SÉMANTIQUE local (REJ_SEMAN), port JAMAIS
      // appelé. insertTransmission reste idempotent (rejeu -> created:false,
      // aucun second événement) : cf. son commentaire (rejectMotif).
      const { id, created } = await this.repo.insertTransmission(job.tenantId, {
        declarantId: job.declarantId,
        transmissionRef,
        type: job.type,
        fluxKind: job.fluxKind,
        periodStart: job.periodStart,
        periodEnd: job.periodEnd,
        invoiceCount,
        xml,
        rejectMotif: 'REJ_SEMAN',
      })
      if (created) {
        this.logger.warn(
          `ereporting transmission ${id} rejetée localement (REJ_SEMAN, XSD invalide) — port jamais appelé : ${validation.errors}`,
        )
      }
      return
    }

    const { id, created } = await this.repo.insertTransmission(job.tenantId, {
      declarantId: job.declarantId,
      transmissionRef,
      type: job.type,
      fluxKind: job.fluxKind,
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
      invoiceCount,
      xml,
    })

    if (!created) {
      // Idempotence & reprise (injection Task 8 #4, revue T6 F1 + A2) : la
      // VÉRITÉ est TOUJOURS en base (jamais le retour du port, TransmitResult
      // ne distingue pas frais/rejeu). `prepared` -> crash antérieur entre
      // insert et transmit (reprise, on continue ci-dessous) ; tout autre
      // statut (transmitted/deposee/rejetee) -> déjà traité, SKIP total.
      const status = await this.repo.findTransmissionStatus(job.tenantId, id)
      if (status !== 'prepared') return
    }

    const result = await this.port.transmit({
      tenantId: job.tenantId,
      transmissionRef,
      fluxKind: job.fluxKind,
      xml,
    })

    try {
      await this.repo.markTransmitted(job.tenantId, id, result.trackingId)
    } catch (err) {
      // CAS périmé (injection Task 8 #5, revue T5 nit 2) : déjà marquée
      // `transmitted` par un traitement concurrent — pas un échec, no-op (pas
      // de raffinement du type d'erreur ici, cf. brief : pas de refactor
      // gratuit du repo pour ce seul cas).
      this.logger.warn(
        `ereporting transmission ${id}: markTransmitted CAS périmé (déjà traité par un concurrent) — ${(err as Error).message}`,
      )
    }
  }
}
