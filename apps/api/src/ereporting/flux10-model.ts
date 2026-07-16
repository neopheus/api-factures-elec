import type {
  Flux10Category,
  IssuerRole,
  TransmissionType,
} from './nomenclature.js'

// Modèle de domaine PUR du rapport Flux 10 (<Report> = TB-0, ereporting.xsd).
// Aucune dépendance NestJS ; les identifiants de code sont en anglais, les
// commentaires tracent les codes TT/TG de la spec (§3.7, Annexe 6 v1.10) pour
// l'audit. Formes : TB-1 obligatoire ; TB-2 (transactions) et TB-3 (paiements)
// structurellement supportées, XOR en pratique côté génération (D1/D10) — un
// rapport porte soit des transactions, soit des paiements, jamais les deux
// (bien que le XSD, permissif, autoriserait techniquement les deux).

// TG-3 (émetteur PA) — schemeId '0238' (SCHEME_ID_PA), roleCode 'WK' (SENDER_ROLE_PA).
export interface Flux10Sender {
  id: string // TT-8
  schemeId: string // TT-7
  name: string // TT-9
  roleCode: string // TT-10
}

// TG-5 (déclarant) — schemeId '0002' (SCHEME_ID_SIREN), roleCode BY|SE (IssuerRole).
export interface Flux10Issuer {
  id: string // TT-13
  schemeId: string // TT-12
  name: string // TT-14
  roleCode: IssuerRole // TT-15
}

// TB-1 : ReportDocument (report.xsd), obligatoire (minOccurs=1 sur <Report>).
export interface ReportDocument {
  id: string // TT-1
  name?: string // TT-2
  issueDateTime: string // TT-3, AAAAMMJJHHMMSS
  typeCode: TransmissionType // TT-4
  sender: Flux10Sender // TG-3
  issuer: Flux10Issuer // TG-5
}

// TG-32 : répartition TVA d'une transaction agrégée B2C 10.3 (pas de devise —
// contrairement à la répartition des paiements, cf. Flux10PaymentSubTotal).
export interface Flux10SubTotal {
  taxPercent: string // TT-86
  taxableAmount: string // TT-87
  taxTotal: string // TT-88
}

// TG-31 : forme agrégée B2C (10.3) — un enregistrement par jour × devise × catégorie.
export interface AggregatedTransaction {
  date: string // TT-77, AAAAMMJJ
  currency: string // TT-78
  taxDueDateTypeCode?: string // TT-80 (option paiement TVA, facultatif)
  categoryCode: Flux10Category // TT-81
  taxExclusiveAmount: string // TT-82
  taxTotal: string // TT-83
  transactionsCount?: number // TT-85 (facultatif, simplification §2.3.3)
  subtotals: Flux10SubTotal[] // TG-32, 1..n
}

// TG-23 : ventilation de la TVA d'une facture (10.1) — forme distincte de
// Flux10SubTotal (TT-56 catégorie et TT-57 taux imbriqués sous TaxCategory).
export interface Flux10InvoiceTaxSubTotal {
  taxableAmount: string // TT-54
  taxAmount: string // TT-55
  categoryCode?: string // TT-56
  percent: string // TT-57
}

// TG-12 : vendeur d'une facture 10.1 (forme minimale XSD — CompanyId + pays).
export interface Flux10InvoiceSeller {
  companyId: string // TT-33
  schemeId: string // TT-33-1
  countryId?: string // TT-35
}

// TG-8 : forme par facture B2B international (10.1) — minimale XSD-valide.
export interface Flux10Invoice {
  id: string // TT-19
  issueDate: string // TT-20
  typeCode: string // TT-21 (UNTDID 1001)
  currency: string // TT-22
  businessProcessId: string // TT-28 (cadre de facturation, BT-23)
  businessProcessTypeId: string // TT-29
  seller: Flux10InvoiceSeller // TG-12
  taxAmount: string // TT-52 (@CurrencyCode = currency, TT-202)
  taxSubTotals: Flux10InvoiceTaxSubTotal[] // TG-23, 1..n
}

// TB-2 : TransactionsReport (transaction.xsd).
export interface TransactionsReport {
  periodStart: string // TT-17, AAAAMMJJ
  periodEnd: string // TT-18, AAAAMMJJ
  invoices: Flux10Invoice[] // TG-8, 0..n (10.1 — B2Bi, agrégation différée D10)
  aggregated: AggregatedTransaction[] // TG-31, 0..n (10.3)
}

// TG-36/TG-39 : répartition par taux d'un paiement — forme distincte de
// Flux10SubTotal (pas de base imposable, une devise optionnelle à la place).
export interface Flux10PaymentSubTotal {
  taxPercent: string // TT-93/TT-97
  currency?: string // TT-94/TT-98
  amount: string // TT-95/TT-99 (montant encaissé)
}

// TG-34 : paiement rattaché à une facture (10.2).
export interface Flux10PaymentInvoice {
  invoiceId: string // TT-91
  issueDate: string // TT-102
  paymentDate: string // TT-92
  subtotals: Flux10PaymentSubTotal[] // TG-36, 1..n
}

// TG-37/TG-38/TG-39 : forme agrégée B2C (10.4) — un enregistrement par date
// de paiement, SANS réf facture ni catégorie (aucun axe TLB1/TPS1 dans les
// paiements, D7) ; répartition par taux (TG-39, même forme que TG-36).
export interface Flux10PaymentAggregate {
  paymentDate: string // TT-96
  subtotals: Flux10PaymentSubTotal[] // TG-39, 1..n
}

// TB-3 : PaymentsReport (payment.xsd) — DEUX sous-flux (D7, Task 7) : 10.2
// per-facture (`invoices`, TG-34, B2Bi) et 10.4 agrégé (`transactions`,
// TG-37, B2C) — un même rapport peut porter les deux SIMULTANÉMENT (séquence
// XSD permissive, round-trip xmllint prouvé, tests/unit/flux10-xml.test.ts).
export interface PaymentsReport {
  periodStart: string // TT-89
  periodEnd: string // TT-90
  invoices: Flux10PaymentInvoice[] // TG-34, 0..n (10.2)
  transactions: Flux10PaymentAggregate[] // TG-37, 0..n (10.4)
}

// TB-0 : <Report> racine.
export interface Flux10Report {
  document: ReportDocument // TB-1 (obligatoire)
  transactions: TransactionsReport | null // TB-2 (0..1)
  payments: PaymentsReport | null // TB-3 (0..1)
}
