import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, InvoiceLine, Party } from '../model/schema.js'

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

// Partie commerciale complète (cac:PartyName + cbc:RegistrationName), partagée
// entre la facture (Invoice) et l'avoir (CreditNote).
export function appendCommercialParty(
  parent: XMLBuilder,
  role: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  party: Party,
): void {
  const p = parent.ele(`cac:${role}`).ele('cac:Party')
  p.ele('cac:PartyName').ele('cbc:Name').txt(party.name)
  const address = p.ele('cac:PostalAddress')
  if (party.address.streetName)
    address.ele('cbc:StreetName').txt(party.address.streetName)
  if (party.address.city) address.ele('cbc:CityName').txt(party.address.city)
  if (party.address.postalCode)
    address.ele('cbc:PostalZone').txt(party.address.postalCode)
  address
    .ele('cac:Country')
    .ele('cbc:IdentificationCode')
    .txt(party.address.countryCode)
  if (party.vatId) {
    const taxScheme = p.ele('cac:PartyTaxScheme')
    taxScheme.ele('cbc:CompanyID').txt(party.vatId)
    taxScheme.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }
  const legal = p.ele('cac:PartyLegalEntity')
  legal.ele('cbc:RegistrationName').txt(party.name)
  if (party.siren) legal.ele('cbc:CompanyID').txt(party.siren)
}

// cac:LegalMonetaryTotal complet (BG-22), identique Invoice/CreditNote.
export function appendLegalMonetaryTotal(
  parent: XMLBuilder,
  invoice: Invoice,
): void {
  const totals = parent.ele('cac:LegalMonetaryTotal')
  addAmount(
    totals,
    'LineExtensionAmount',
    invoice.totals.sumOfLines,
    invoice.currency,
  )
  addAmount(
    totals,
    'TaxExclusiveAmount',
    invoice.totals.taxExclusive,
    invoice.currency,
  )
  addAmount(
    totals,
    'TaxInclusiveAmount',
    invoice.totals.taxInclusive,
    invoice.currency,
  )
  addAmount(totals, 'PayableAmount', invoice.totals.payable, invoice.currency)
}

// cac:Item (Name + ClassifiedTaxCategory) puis cac:Price : identiques par ligne.
export function appendItemAndPrice(
  line: XMLBuilder,
  invoiceLine: InvoiceLine,
  currency: string,
): void {
  const item = line.ele('cac:Item')
  item.ele('cbc:Name').txt(invoiceLine.name)
  const taxCategory = item.ele('cac:ClassifiedTaxCategory')
  taxCategory.ele('cbc:ID').txt(invoiceLine.vatCategory)
  taxCategory.ele('cbc:Percent').txt(invoiceLine.vatRate)
  taxCategory.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  const price = line.ele('cac:Price')
  addAmount(price, 'PriceAmount', invoiceLine.unitPrice, currency)
}
