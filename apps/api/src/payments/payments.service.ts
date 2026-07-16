import type { VatBreakdown } from '@factelec/invoice-core'
import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import Big from 'big.js'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: InvoicesRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import type { PaymentCapture, PaymentSubtotalCapture } from './payment.model.js'
import type { PaymentRow } from './payments.repository.js'
// biome-ignore lint/style/useImportType: PaymentsRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { PaymentsRepository } from './payments.repository.js'

// Normalise un taux ("20.00", "20.0", "20") vers une forme numérique unique
// via big.js (seule source de vérité arithmétique du projet sur les
// montants/taux `text` Flux 10, D2/Task 4) — un `taxPercent` posté et un
// `vatBreakdown[].rate` facturé peuvent différer en FORME (nombre de
// décimales) sans différer en VALEUR ; une comparaison de chaînes brutes les
// traiterait à tort comme des taux distincts.
function normalizeRate(rate: string): string {
  return new Big(rate).toString()
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly invoices: InvoicesRepository,
    private readonly payments: PaymentsRepository,
  ) {}

  // EXIGENCE DE SÉCURITÉ N°1 (revue T4, MEDIUM-1 — checkpoint IMPÉRATIF T5) :
  // `loadCanonical` AVANT toute écriture. `null` couvre À LA FOIS une
  // facture inconnue ET une facture d'un AUTRE tenant (invisible sous RLS) —
  // la MÊME exception, byte-identique, est levée dans les deux cas : ne
  // jamais laisser fuiter l'existence d'une facture cross-tenant. Aucun
  // chemin ne doit atteindre `insertPayment` sans passer par ce garde — les
  // FK Postgres ignorent la RLS (invariant documenté sur
  // `PaymentsRepository.insertPayment`) : sans lui, une collision
  // `(invoice_id, reference)` cross-tenant ferait échouer le reload en 500
  // au lieu d'un 404 anti-fuite.
  async capture(
    tenantId: string,
    body: PaymentCapture,
  ): Promise<{ id: string; created: boolean }> {
    const invoice = await this.invoices.loadCanonical(tenantId, body.invoiceId)
    if (!invoice) throw this.notFound()

    // Idempotence (D5) : un re-POST de LA MÊME référence n'écrit jamais rien
    // de nouveau (`insertPayment` : ON CONFLICT DO NOTHING + reload, Task 4,
    // les sous-totaux postés au 2e appel sont ignorés même s'ils diffèrent).
    // Les contrôles d'intégrité ci-dessous ne portent donc QUE sur les
    // captures réellement nouvelles : sans ce court-circuit, sommer les
    // sous-totaux déjà capturés (qui incluent CETTE référence) puis y
    // rajouter les mêmes montants postés à nouveau doublerait
    // artificiellement le cumul et ferait échouer en 422 un simple rejeu
    // idempotent légitime.
    const existing = await this.payments.listPayments(tenantId, body.invoiceId)
    const isReplay = existing.some((p) => p.reference === body.reference)
    if (!isReplay) {
      this.assertKnownRates(invoice.vatBreakdown, body.subtotals)
      await this.assertNoOverpayment(
        tenantId,
        body.invoiceId,
        invoice.vatBreakdown,
        body.subtotals,
      )
    }

    return this.payments.insertPayment(tenantId, body)
  }

  async list(tenantId: string, invoiceId: string): Promise<PaymentRow[]> {
    const invoice = await this.invoices.loadCanonical(tenantId, invoiceId)
    if (!invoice) throw this.notFound()
    return this.payments.listPayments(tenantId, invoiceId)
  }

  // D5 : chaque `taxPercent` posté doit appartenir à la ventilation TVA de
  // la facture liée (`vatBreakdown`) — un taux étranger à la facture est
  // structurellement invalide (422 `validation`), jamais une question de
  // plafond.
  private assertKnownRates(
    vatBreakdown: VatBreakdown[],
    subtotals: PaymentSubtotalCapture[],
  ): void {
    const known = new Set(vatBreakdown.map((v) => normalizeRate(v.rate)))
    for (const subtotal of subtotals) {
      if (!known.has(normalizeRate(subtotal.taxPercent))) {
        throw new UnprocessableEntityException(
          problem(422, ProblemType.validation, 'Unknown VAT rate', {
            errors: [
              {
                path: 'subtotals.taxPercent',
                message: `taxPercent ${subtotal.taxPercent} is not part of the invoice VAT breakdown`,
              },
            ],
          }),
        )
      }
    }
  }

  // D5 — INTERPRÉTATION flaggée (sur-encaissement, tolérance/arrondi à
  // confirmer go-live) : le total TTC par taux est reconstruit ICI comme
  // `taxableAmount + taxAmount` de la ventilation facture (BT-116+BT-117,
  // aucun champ TTC par taux n'existe directement sur `vatBreakdown`) ;
  // comparaison STRICTE `≤`, sans tolérance d'arrondi. Le cumul déjà capturé
  // réutilise `sumCapturedByRate` (Task 4, big.js) — appelé UNIQUEMENT ici,
  // jamais sur le chemin de rejeu idempotent (cf. `capture`), qui inclurait
  // sinon la référence en cours de re-soumission dans son propre plafond.
  private async assertNoOverpayment(
    tenantId: string,
    invoiceId: string,
    vatBreakdown: VatBreakdown[],
    subtotals: PaymentSubtotalCapture[],
  ): Promise<void> {
    // Le plafond par TAUX cumule TOUTES les catégories de ventilation portant
    // ce taux (revue T5, LOW-1) : `vatBreakdown` est groupé par
    // (catégorie, taux) — p. ex. Z et E partagent le taux 0 — et un `set`
    // écraserait le bucket précédent, plafonnant à UNE catégorie au lieu de
    // leur somme (422 à tort, jamais permissif, mais faux quand même).
    const ttcByRate = new Map<string, Big>()
    for (const entry of vatBreakdown) {
      const key = normalizeRate(entry.rate)
      const current = ttcByRate.get(key) ?? new Big(0)
      ttcByRate.set(
        key,
        current.plus(entry.taxableAmount).plus(entry.taxAmount),
      )
    }

    const captured = await this.payments.sumCapturedByRate(tenantId, invoiceId)
    const capturedByRate = new Map(
      captured.map((c) => [normalizeRate(c.taxPercent), new Big(c.amount)]),
    )

    const newByRate = new Map<string, Big>()
    for (const subtotal of subtotals) {
      const key = normalizeRate(subtotal.taxPercent)
      const current = newByRate.get(key) ?? new Big(0)
      newByRate.set(key, current.plus(subtotal.amount))
    }

    for (const [rate, added] of newByRate) {
      const total = ttcByRate.get(rate) ?? new Big(0)
      const already = capturedByRate.get(rate) ?? new Big(0)
      if (already.plus(added).gt(total)) {
        throw new UnprocessableEntityException(
          problem(
            422,
            ProblemType.businessRule,
            'Overpayment beyond invoice total',
            {
              detail: `cumulative capture for rate ${rate} exceeds the invoice TTC total`,
            },
          ),
        )
      }
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Invoice not found'),
    )
  }
}
