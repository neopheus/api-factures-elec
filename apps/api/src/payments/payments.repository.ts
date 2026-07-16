import { Injectable } from '@nestjs/common'
import Big from 'big.js'
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { paymentSubtotals, payments } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type { PaymentCapture } from './payment.model.js'

export interface PaymentSubtotalRow {
  taxPercent: string
  amount: string
}

export interface PaymentRow {
  id: string
  invoiceId: string
  paymentDate: string
  currency: string
  reference: string
  subtotals: PaymentSubtotalRow[]
  createdAt: Date
  updatedAt: Date
}

// Agrégat par taux (Task 5, intégrité anti-sur-encaissement ; Task 7,
// agrégation TB-3) — amount toujours 2 décimales.
export interface CapturedByRate {
  taxPercent: string
  amount: string
}

const PAYMENT_COLUMNS = {
  id: payments.id,
  invoiceId: payments.invoiceId,
  paymentDate: payments.paymentDate,
  currency: payments.currency,
  reference: payments.reference,
  createdAt: payments.createdAt,
  updatedAt: payments.updatedAt,
} as const

@Injectable()
export class PaymentsRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Backstop anti-doublon de capture (D5, amendement binding) : idempotent
  // via l'index unique (invoice_id, reference) — miroir
  // CdvTransmissionRepository.insertTransmission /
  // EreportingRepository.insertTransmission (ON CONFLICT DO NOTHING +
  // reload). Sur INSERT réel, les sous-totaux s'insèrent dans LA MÊME
  // transaction — UNIQUEMENT si created (un re-POST du même (invoice,
  // reference) ne doit JAMAIS écraser ni dupliquer les sous-totaux d'origine).
  //
  // INVARIANT APPELANT (revue T4, MEDIUM-1) : l'appelant DOIT avoir vérifié
  // sous RLS que `invoiceId` appartient au tenant AVANT d'appeler (motif
  // loadCanonical → 404 anti-fuite, Task 5). Les contraintes FK Postgres
  // IGNORENT la RLS : sans ce garde, un tenant pourrait créer un payment
  // pointant la facture d'un autre tenant, et une collision
  // (invoice_id, reference) avec une ligne d'un autre tenant rend le reload
  // sous RLS aveugle → le throw défensif ci-dessous se déclenche alors de
  // façon DÉTERMINISTE (ce n'est pas seulement une course improbable).
  async insertPayment(
    tenantId: string,
    input: PaymentCapture,
  ): Promise<{ id: string; created: boolean }> {
    return this.tenant.run(tenantId, async (db) => {
      const inserted = await db
        .insert(payments)
        .values({
          tenantId,
          invoiceId: input.invoiceId,
          paymentDate: input.paymentDate,
          currency: input.currency ?? 'EUR',
          reference: input.reference,
        })
        .onConflictDoNothing({
          target: [payments.invoiceId, payments.reference],
        })
        .returning({ id: payments.id })

      const createdRow = inserted[0]
      if (createdRow) {
        await db.insert(paymentSubtotals).values(
          input.subtotals.map((subtotal) => ({
            tenantId,
            paymentId: createdRow.id,
            taxPercent: subtotal.taxPercent,
            amount: subtotal.amount,
          })),
        )
        return { id: createdRow.id, created: true }
      }

      // Conflit : une capture existe déjà pour (facture, référence) — la
      // recharger plutôt que d'en émettre une seconde (idempotence D5).
      const existing = await db
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.invoiceId, input.invoiceId),
            eq(payments.reference, input.reference),
          ),
        )
        .limit(1)
      const existingRow = existing[0]
      if (!existingRow) {
        throw new Error(
          'insertPayment: conflict detected but no existing row found',
        )
      }
      return { id: existingRow.id, created: false }
    })
  }

  async listPayments(
    tenantId: string,
    invoiceId: string,
  ): Promise<PaymentRow[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select(PAYMENT_COLUMNS)
        .from(payments)
        .where(eq(payments.invoiceId, invoiceId))
        .orderBy(desc(payments.createdAt))
      return attachSubtotals(db, rows)
    })
  }

  // Consommé par l'intégrité anti-sur-encaissement (Task 5) et
  // potentiellement par l'agrégation TB-3 (Task 7). Motif retenu :
  // agrégation EN TYPESCRIPT via `big.js` (déjà la SEULE source de vérité
  // arithmétique du projet sur les montants `text` Flux 10, cf.
  // flux10-aggregate.ts) plutôt qu'un `sql\`sum(cast(...))\`` — aucun
  // repository du projet ne caste des montants texte en SQL à ce jour ;
  // introduire ce motif ici aurait dupliqué la logique d'arrondi 2
  // décimales (D2) dans DEUX langages au lieu d'un. `toFixed(2)` garantit
  // le format 2 décimales attendu, cohérent avec les montants de facture
  // (comparaison Task 5) et le format `text` stocké (D5).
  async sumCapturedByRate(
    tenantId: string,
    invoiceId: string,
  ): Promise<CapturedByRate[]> {
    const rows = await this.listPayments(tenantId, invoiceId)
    const sums = new Map<string, Big>()
    for (const row of rows) {
      for (const subtotal of row.subtotals) {
        const current = sums.get(subtotal.taxPercent) ?? new Big(0)
        sums.set(subtotal.taxPercent, current.plus(subtotal.amount))
      }
    }
    return Array.from(sums, ([taxPercent, amount]) => ({
      taxPercent,
      amount: amount.toFixed(2),
    }))
  }

  // Bornes AAAAMMJJ INCLUSIVES sur paymentDate (texte, largeur fixe) —
  // comparaison lexicographique valide, même motif que
  // EreportingRepository.invoicesForPeriod (issue_date texte). Consommé par
  // l'agrégation TB-3 (Task 7, cadence PAIEMENTS).
  async listPaymentsForPeriod(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<PaymentRow[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select(PAYMENT_COLUMNS)
        .from(payments)
        .where(
          and(gte(payments.paymentDate, from), lte(payments.paymentDate, to)),
        )
        .orderBy(asc(payments.paymentDate))
      return attachSubtotals(db, rows)
    })
  }
}

interface PaymentRowBase {
  id: string
  invoiceId: string
  paymentDate: string
  currency: string
  reference: string
  createdAt: Date
  updatedAt: Date
}

async function attachSubtotals(
  db: Db,
  rows: PaymentRowBase[],
): Promise<PaymentRow[]> {
  if (rows.length === 0) return []
  const subtotalRows = await db
    .select({
      paymentId: paymentSubtotals.paymentId,
      taxPercent: paymentSubtotals.taxPercent,
      amount: paymentSubtotals.amount,
    })
    .from(paymentSubtotals)
    .where(
      inArray(
        paymentSubtotals.paymentId,
        rows.map((row) => row.id),
      ),
    )
  const byPayment = new Map<string, PaymentSubtotalRow[]>()
  for (const subtotal of subtotalRows) {
    const list = byPayment.get(subtotal.paymentId) ?? []
    list.push({ taxPercent: subtotal.taxPercent, amount: subtotal.amount })
    byPayment.set(subtotal.paymentId, list)
  }
  return rows.map((row) => ({
    ...row,
    subtotals: byPayment.get(row.id) ?? [],
  }))
}
