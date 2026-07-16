import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: PaymentsRepository résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { PaymentsRepository } from '../payments/payments.repository.js'
import type { EreportingGenerationJob } from '../queue/ereporting-generation.job.js'
// biome-ignore lint/style/useImportType: EreportingRepository résolu par Nest via design:paramtypes.
import { EreportingRepository } from './ereporting.repository.js'
import {
  validateEreportingXml,
  type XsdValidationResult,
} from './ereporting-xsd-validator.js'
import {
  aggregateTransactions,
  classifyEreportingOperation,
} from './flux10-aggregate.js'
import type { Flux10Report, ReportDocument } from './flux10-model.js'
import { aggregatePayments } from './flux10-payments-aggregate.js'
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

// Pipeline de génération e-reporting Flux 10 — tâche d'INTÉGRATION : tout ce
// que les tâches précédentes ont posé s'assemble ici, pour DEUX flux disjoints
// (D7, Task 8) partageant la même mécanique de persistance/transmission :
//   'transactions' (TB-2, Task 7 plan 2.3) : période -> factures (RLS) ->
//     agrégat 10.3/10.1 -> Flux10Report{transactions} -> XML XSD-validé ->
//     persistance idempotente -> transmission -> transmitted. À blanc
//     (aucune opération 10.3/10.1) -> RIEN (D6).
//   'payments' (TB-3, Task 8 plan 3.2) : période -> encaissements (RLS) ->
//     agrégat 10.2/10.4 (aggregatePayments, ASYNC — charge la facture liée par
//     encaissement) -> Flux10Report{payments} -> même XML/validation/
//     persistance/transmission. À blanc (aucun encaissement e-reportable) ->
//     RIEN (D6), journalisé.
// Les deux branches convergent dans `persistAndTransmit` : seule la
// construction du `Flux10Report` diffère (XOR structurel — jamais les deux
// non-null à la fois, discipline d'appelant, cf. flux10-model.ts).
@Injectable()
export class EreportingGenerationService {
  private readonly logger = new Logger(EreportingGenerationService.name)
  private readonly paId: string
  private readonly paSchemeId: string
  private readonly paName: string

  constructor(
    private readonly repo: EreportingRepository,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly invoicesRepo: InvoicesRepository,
    @Inject(FLUX10_TRANSMISSION)
    private readonly port: Flux10TransmissionPort,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.paId = config.get('EREPORTING_PA_ID', { infer: true })
    this.paSchemeId = config.get('EREPORTING_PA_SCHEME_ID', { infer: true })
    this.paName = config.get('EREPORTING_PA_NAME', { infer: true })
  }

  async generate(job: EreportingGenerationJob): Promise<void> {
    if (job.fluxKind === 'transactions') {
      await this.generateTransactions(job)
      return
    }
    if (job.fluxKind === 'payments') {
      await this.generatePayments(job)
      return
    }
    // Garde défensive (payload de job non typé côté Redis) : un fluxKind
    // inconnu des deux branches ci-dessus serait un bug ailleurs (jamais émis
    // par EreportingSweepService) — throw explicite (retry BullMQ,
    // investigation requise) plutôt qu'un traitement silencieux erroné.
    throw new Error(
      `ereporting-generation: fluxKind '${job.fluxKind}' non pris en charge — ne devrait jamais être enfilé`,
    )
  }

  // TB-1 (injection Task 8 #7) : Sender = PA depuis env, Issuer = déclarant
  // (siren/role du PAYLOAD — recopiés par le sweep depuis la même ligne
  // ereporting_declarants au moment de l'enfilement ; name rechargé par
  // l'appelant, seul champ absent du payload minimal). Commun aux deux flux.
  private buildDocument(
    job: EreportingGenerationJob,
    transmissionRef: string,
    declarantName: string,
  ): ReportDocument {
    return {
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
        name: declarantName,
        roleCode: job.role,
      },
    }
  }

  private async generateTransactions(
    job: EreportingGenerationJob,
  ): Promise<void> {
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
    const report: Flux10Report = {
      document: this.buildDocument(job, transmissionRef, declarant.name),
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
    await this.persistAndTransmit(
      job,
      transmissionRef,
      xml,
      invoiceCount,
      validation,
    )
  }

  // Branche 'payments' (TB-3, Task 8 plan 3.2, D7) : encaissements de la
  // période (RLS — `listPaymentsForPeriod` filtre par tenant+dates seulement,
  // la MAILLE DÉCLARANT est appliquée en aval via `filterInvoice` : revue T8
  // MAJOR-1, miroir du `eq(partySiren, siren)` d'invoicesForPeriod — SE →
  // siren vendeur, BY → siren acheteur de la facture liée ; sans elle, un
  // tenant multi-déclarants transmettrait les mêmes encaissements sous CHAQUE
  // déclarant dû) -> aggregatePayments (ASYNC : charge la facture liée PAR
  // encaissement, loader scopé tenant, cf. task-7-report.md § Points
  // d'attention Task 8) -> Flux10Report{payments} XOR transactions.
  //
  // PAS de conversion `periodDateToIso` ici (à la différence de
  // generateTransactions) : `payments.payment_date` est stocké AAAAMMJJ
  // (schema.ts, motif TT-92/TT-102), le MÊME format que `job.periodStart`/
  // `periodEnd` — contrairement à `invoices.issue_date`, stocké ISO
  // (AAAA-MM-JJ, motif @factelec/invoice-core), qui exige la conversion.
  private async generatePayments(job: EreportingGenerationJob): Promise<void> {
    const paymentRows = await this.paymentsRepo.listPaymentsForPeriod(
      job.tenantId,
      job.periodStart,
      job.periodEnd,
    )

    const paymentsReport = await aggregatePayments(paymentRows, {
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
      loadInvoice: (invoiceId) =>
        this.invoicesRepo.loadCanonical(job.tenantId, invoiceId),
      filterInvoice: (invoice) =>
        (job.role === 'SE' ? invoice.seller.siren : invoice.buyer.siren) ===
        job.siren,
    })
    if (!paymentsReport) {
      // À blanc (D6, Step 2 du brief) : ZÉRO écriture, ZÉRO appel port —
      // JOURNALISÉ (contrairement au silence de generateTransactions) : un
      // encaissement peut exister sur la période sans jamais produire
      // d'opération e-reportable (services-only, note 119) — distinguer
      // « rien à déclarer » d'un bug d'agrégation amont mérite une trace.
      this.logger.log(
        `ereporting payments: aucune opération e-reportable pour le déclarant ${job.declarantId}, période ${job.periodStart}-${job.periodEnd} (transmission à blanc)`,
      )
      return
    }

    const declarant = await this.repo.findDeclarant(
      job.tenantId,
      job.declarantId,
    )
    if (!declarant) {
      this.logger.warn(
        `ereporting declarant ${job.declarantId} vanished before payments generation — no-op`,
      )
      return
    }

    const transmissionRef = buildTransmissionRef(
      job.declarantId,
      job.periodStart,
      job.type,
    )
    const report: Flux10Report = {
      document: this.buildDocument(job, transmissionRef, declarant.name),
      transactions: null,
      payments: paymentsReport,
    }

    const xml = generateEreportingXml(report)
    // Métrique de volume analogue à `invoiceCount` côté transactions (compte
    // d'entrée de la période, PAS le compte d'opérations réellement émises
    // dans le PaymentsReport — même sémantique « best-effort » que la
    // transactions, cf. son propre calcul filtré sur '10.3' seulement).
    const invoiceCount = paymentRows.length

    const validation = await validateEreportingXml(xml)
    await this.persistAndTransmit(
      job,
      transmissionRef,
      xml,
      invoiceCount,
      validation,
    )
  }

  // Commun aux deux flux (injections Task 8 #4/#5/#6, revues T5/T6) :
  // validation XSD DGFiP AVANT toute écriture -> XSD-invalide = rejet
  // SÉMANTIQUE local (REJ_SEMAN), port JAMAIS appelé ; XSD-valide ->
  // persistance idempotente -> transmission -> transmitted.
  private async persistAndTransmit(
    job: EreportingGenerationJob,
    transmissionRef: string,
    xml: string,
    invoiceCount: number,
    validation: XsdValidationResult,
  ): Promise<void> {
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
