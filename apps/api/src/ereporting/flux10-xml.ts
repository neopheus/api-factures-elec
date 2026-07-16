import Big from 'big.js'
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type {
  Flux10Invoice,
  Flux10PaymentAggregate,
  Flux10PaymentInvoice,
  Flux10Report,
  PaymentsReport,
  TransactionsReport,
} from './flux10-model.js'

// Génération XSD-valide du rapport Flux 10 (ereporting.xsd + imports
// report/transaction/payment/parametre). L'instance est SANS préfixe de
// namespace : aucun des 5 XSD ne déclare `elementFormDefault="qualified"`
// (defaut "unqualified"), donc les éléments localement déclarés — la totalité
// du contenu ici — restent en "no namespace" quel que soit le targetNamespace
// du schéma qui les définit (report/transaction/payment ont un
// targetNamespace mais ereporting.xsd, qui déclare l'élément racine <Report>,
// n'en a pas). Confirmé empiriquement par xmllint (tests/unit/flux10-xml).
export function generateEreportingXml(report: Flux10Report): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc.ele('Report')
  appendReportDocument(root, report.document)
  if (report.transactions) appendTransactionsReport(root, report.transactions)
  else if (report.payments) appendPaymentsReport(root, report.payments)
  return doc.end({ prettyPrint: true })
}

function appendReportDocument(
  root: XMLBuilder,
  d: Flux10Report['document'],
): void {
  const rd = root.ele('ReportDocument')
  rd.ele('Id').txt(d.id)
  if (d.name) rd.ele('Name').txt(d.name)
  rd.ele('IssueDateTime').ele('DateTimeString').txt(d.issueDateTime)
  rd.ele('TypeCode').txt(d.typeCode)
  const s = rd.ele('Sender')
  s.ele('Id').att('schemeId', d.sender.schemeId).txt(d.sender.id)
  s.ele('Name').txt(d.sender.name)
  s.ele('RoleCode').txt(d.sender.roleCode)
  const i = rd.ele('Issuer')
  i.ele('Id').att('schemeId', d.issuer.schemeId).txt(d.issuer.id)
  i.ele('Name').txt(d.issuer.name)
  i.ele('RoleCode').txt(d.issuer.roleCode)
}

function appendTransactionsReport(
  root: XMLBuilder,
  t: TransactionsReport,
): void {
  const tr = root.ele('TransactionsReport')
  const p = tr.ele('ReportPeriod')
  p.ele('StartDate').txt(t.periodStart)
  p.ele('EndDate').txt(t.periodEnd)
  for (const inv of t.invoices) appendInvoice(tr, inv)
  for (const a of t.aggregated) {
    const x = tr.ele('Transactions')
    x.ele('Date').txt(a.date)
    x.ele('TransactionsCurrency').txt(a.currency)
    if (a.taxDueDateTypeCode)
      x.ele('TaxDueDateTypeCode').txt(a.taxDueDateTypeCode)
    x.ele('CategoryCode').txt(a.categoryCode)
    x.ele('TaxExclusiveAmount').txt(a.taxExclusiveAmount)
    x.ele('TaxTotal').txt(a.taxTotal)
    if (a.transactionsCount !== undefined)
      x.ele('TransactionsCount').txt(String(a.transactionsCount))
    for (const st of a.subtotals) {
      const s = x.ele('TaxSubtotal')
      s.ele('TaxPercent').txt(st.taxPercent)
      s.ele('TaxableAmount').txt(st.taxableAmount)
      s.ele('TaxTotal').txt(st.taxTotal)
    }
  }
}

function appendInvoice(tr: XMLBuilder, inv: Flux10Invoice): void {
  const x = tr.ele('Invoice')
  x.ele('ID').txt(inv.id)
  x.ele('IssueDate').txt(inv.issueDate)
  x.ele('TypeCode').txt(inv.typeCode)
  x.ele('CurrencyCode').txt(inv.currency)
  const bp = x.ele('BusinessProcess')
  bp.ele('ID').txt(inv.businessProcessId)
  bp.ele('TypeID').txt(inv.businessProcessTypeId)
  const seller = x.ele('Seller')
  seller
    .ele('CompanyId')
    .att('schemeId', inv.seller.schemeId)
    .txt(inv.seller.companyId)
  if (inv.seller.countryId)
    seller.ele('PostalAddress').ele('CountryId').txt(inv.seller.countryId)
  const mt = x.ele('MonetaryTotal')
  mt.ele('TaxAmount').att('CurrencyCode', inv.currency).txt(inv.taxAmount)
  for (const st of inv.taxSubTotals) {
    const s = x.ele('TaxSubTotal')
    s.ele('TaxableAmount').txt(st.taxableAmount)
    s.ele('TaxAmount').txt(st.taxAmount)
    const cat = s.ele('TaxCategory')
    if (st.categoryCode) cat.ele('Code').txt(st.categoryCode)
    cat.ele('Percent').txt(st.percent)
  }
}

// TB-3 : PaymentsReport — DEUX sous-flux (D7, Task 7) émis dans l'ORDRE de la
// séquence XSD (payment.xsd, TB-3) : ReportPeriod, puis Invoice(0..n, 10.2),
// puis Transactions(0..n, 10.4) — la coexistence des deux est XSD-valide
// (round-trip xmllint, tests/unit/flux10-xml.test.ts).
function appendPaymentsReport(root: XMLBuilder, pmt: PaymentsReport): void {
  const pr = root.ele('PaymentsReport')
  const p = pr.ele('ReportPeriod')
  p.ele('StartDate').txt(pmt.periodStart)
  p.ele('EndDate').txt(pmt.periodEnd)
  for (const inv of pmt.invoices) appendPaymentInvoice(pr, inv)
  for (const agg of pmt.transactions) appendPaymentAggregate(pr, agg)
}

// TT-95/TT-99 : MONTANT 19.6 (Annexe 6 v1.10) — les montants CAPTURÉS/agrégés
// en amont (Tasks 4/5/7, payments/flux10-payments-aggregate) restent en 2
// décimales (motif AMOUNT_RE, cohérent avec les totaux facture) ; l'ÉMETTEUR,
// seule frontière qui connaît le format XSD cible, reformate ici à 6
// décimales (D7 : « l'émetteur formate — les captures sont en 2 décimales »).
function formatPaymentAmount(amount: string): string {
  return new Big(amount).toFixed(6)
}

function appendPaymentInvoice(pr: XMLBuilder, inv: Flux10PaymentInvoice): void {
  const x = pr.ele('Invoice')
  x.ele('InvoiceID').txt(inv.invoiceId)
  x.ele('IssueDate').txt(inv.issueDate)
  const pay = x.ele('Payment')
  pay.ele('Date').txt(inv.paymentDate)
  for (const st of inv.subtotals) {
    const s = pay.ele('SubTotals')
    s.ele('TaxPercent').txt(st.taxPercent)
    if (st.currency) s.ele('CurrencyCode').txt(st.currency)
    s.ele('Amount').txt(formatPaymentAmount(st.amount))
  }
}

// TG-37/38/39 : forme agrégée B2C (10.4) — un `<Transactions>` par date de
// paiement, SubTotals par taux à l'intérieur (aucune réf facture ni
// catégorie — cf. bannière `Flux10PaymentAggregate`, flux10-model.ts).
function appendPaymentAggregate(
  pr: XMLBuilder,
  agg: Flux10PaymentAggregate,
): void {
  const x = pr.ele('Transactions')
  const pay = x.ele('Payment')
  pay.ele('Date').txt(agg.paymentDate)
  for (const st of agg.subtotals) {
    const s = pay.ele('SubTotals')
    s.ele('TaxPercent').txt(st.taxPercent)
    if (st.currency) s.ele('CurrencyCode').txt(st.currency)
    s.ele('Amount').txt(formatPaymentAmount(st.amount))
  }
}
