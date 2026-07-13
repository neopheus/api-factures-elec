import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice } from '../model/schema.js'

export const NS_INVOICE =
  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
export const NS_CREDIT_NOTE =
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
export const NS_CAC =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
export const NS_CBC =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'

export function addAmount(
  parent: XMLBuilder,
  name: string,
  value: string,
  currency: string,
): void {
  parent.ele(`cbc:${name}`).att('currencyID', currency).txt(value)
}

// cac:TaxTotal (BG-22/BG-23) : identique pour la facture commerciale et l'extrait
// de flux. TaxAmount global puis une ventilation par (catégorie, taux), avec les
// motifs d'exonération BT-120/121 entre cbc:Percent et cac:TaxScheme.
export function appendTaxTotal(parent: XMLBuilder, invoice: Invoice): void {
  const taxTotal = parent.ele('cac:TaxTotal')
  addAmount(taxTotal, 'TaxAmount', invoice.totals.taxAmount, invoice.currency)
  for (const b of invoice.vatBreakdown) {
    const sub = taxTotal.ele('cac:TaxSubtotal')
    addAmount(sub, 'TaxableAmount', b.taxableAmount, invoice.currency)
    addAmount(sub, 'TaxAmount', b.taxAmount, invoice.currency)
    const category = sub.ele('cac:TaxCategory')
    category.ele('cbc:ID').txt(b.category)
    category.ele('cbc:Percent').txt(b.rate)
    if (b.exemptionReasonCode)
      category.ele('cbc:TaxExemptionReasonCode').txt(b.exemptionReasonCode)
    if (b.exemptionReason)
      category.ele('cbc:TaxExemptionReason').txt(b.exemptionReason)
    category.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }
}
