import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'
import {
  addAmount,
  appendTaxTotal,
  NS_CAC,
  NS_CBC,
  NS_CREDIT_NOTE,
  NS_INVOICE,
} from '../ubl/common.js'
import { MissingBusinessProcessTypeError } from './errors.js'

export type FluxProfile = 'BASE' | 'FULL'

// Partie « fiscale » : ni cac:PartyName ni cbc:RegistrationName (interdits F1).
// PartyLegalEntity = cbc:CompanyID seul, omis si le SIREN est absent (sinon bloc vide invalide).
function addFluxParty(
  parent: XMLBuilder,
  role: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  party: Party,
): void {
  const p = parent.ele(`cac:${role}`).ele('cac:Party')
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
  if (party.siren) {
    p.ele('cac:PartyLegalEntity').ele('cbc:CompanyID').txt(party.siren)
  }
}

export function generateFluxExtractUbl(
  invoice: Invoice,
  profile: FluxProfile,
): string {
  if (!invoice.businessProcessType) {
    throw new MissingBusinessProcessTypeError()
  }
  const isCredit = invoice.typeCode === '381'
  const rootNs = isCredit ? NS_CREDIT_NOTE : NS_INVOICE
  const rootName = isCredit ? 'CreditNote' : 'Invoice'
  const typeCodeEl = isCredit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'
  const lineEl = isCredit ? 'CreditNoteLine' : 'InvoiceLine'
  const qtyEl = isCredit ? 'CreditedQuantity' : 'InvoicedQuantity'

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(rootNs, rootName)
    .att('xmlns:cac', NS_CAC)
    .att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  // cbc:ProfileID (BT-23, cadre de facturation) : valeur prescrite par la règle de
  // gestion DGFiP G1.02 (Annexe 7 v1.9), obligatoire F1.
  root.ele('cbc:ProfileID').txt(invoice.businessProcessType)
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  // cbc:DueDate : absent du CreditNoteType OASIS, jamais émis pour l'avoir.
  // Comportement Invoice inchangé (émis si présent).
  if (!isCredit && invoice.dueDate) root.ele('cbc:DueDate').txt(invoice.dueDate)
  root.ele(`cbc:${typeCodeEl}`).txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  addFluxParty(root, 'AccountingSupplierParty', invoice.seller)
  addFluxParty(root, 'AccountingCustomerParty', invoice.buyer)

  appendTaxTotal(root, invoice)

  // LegalMonetaryTotal réduit au SEUL TaxExclusiveAmount (F1).
  const total = root.ele('cac:LegalMonetaryTotal')
  addAmount(
    total,
    'TaxExclusiveAmount',
    invoice.totals.taxExclusive,
    invoice.currency,
  )

  // BASE : aucune ligne (cac:InvoiceLine/cac:CreditNoteLine commenté dans les deux
  // XSD F1 BASE — un élément présent est rejeté « This element is not expected »).
  // FULL : lignes épurées obligatoires (minOccurs="1" dans les deux XSD F1 FULL —
  // absence rejetée « Missing child element(s) »). Symétrique Invoice/CreditNote,
  // vérifié xmllint le 2026-07-13 (F1BASE/F1FULL_UBL{-,_}CreditNote-2.1.xsd).
  const emitLines = profile === 'FULL'
  if (emitLines) {
    for (const line of invoice.lines) {
      const l = root.ele(`cac:${lineEl}`)
      l.ele(`cbc:${qtyEl}`).att('unitCode', line.unitCode).txt(line.quantity)
      l.ele('cac:Item').ele('cbc:Name').txt(line.name)
      const price = l.ele('cac:Price')
      addAmount(price, 'PriceAmount', line.unitPrice, invoice.currency)
    }
  }

  return doc.end({ prettyPrint: true })
}
