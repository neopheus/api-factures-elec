import { create } from 'xmlbuilder2'
import type { Invoice } from '../model/schema.js'
import {
  appendCommercialParty,
  appendItemAndPrice,
  appendLegalMonetaryTotal,
  appendTaxTotal,
  NS_CAC,
  NS_CBC,
  NS_CREDIT_NOTE,
} from './common.js'

// UBL 2.1 CreditNote (avoir, typeCode 381). Différences vs Invoice : racine et
// namespace CreditNote-2, cbc:CreditNoteTypeCode, cac:CreditNoteLine /
// cbc:CreditedQuantity, et PAS de cbc:DueDate (absent du CreditNoteType OASIS).
export function generateCreditNote(invoice: Invoice): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_CREDIT_NOTE, 'CreditNote')
    .att('xmlns:cac', NS_CAC)
    .att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  root.ele('cbc:CreditNoteTypeCode').txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  appendCommercialParty(root, 'AccountingSupplierParty', invoice.seller)
  appendCommercialParty(root, 'AccountingCustomerParty', invoice.buyer)
  appendTaxTotal(root, invoice)
  appendLegalMonetaryTotal(root, invoice)

  for (const line of invoice.lines) {
    const l = root.ele('cac:CreditNoteLine')
    l.ele('cbc:ID').txt(line.id)
    l.ele('cbc:CreditedQuantity')
      .att('unitCode', line.unitCode)
      .txt(line.quantity)
    l.ele('cbc:LineExtensionAmount')
      .att('currencyID', invoice.currency)
      .txt(line.lineNetAmount)
    appendItemAndPrice(l, line, invoice.currency)
  }

  return doc.end({ prettyPrint: true })
}
