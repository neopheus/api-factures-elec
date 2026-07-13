import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'
import {
  addAmount,
  appendTaxTotal,
  NS_CAC,
  NS_CBC,
  NS_INVOICE,
} from './common.js'
import { UnsupportedTypeCodeError } from './errors.js'

function addParty(
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

export function generateUbl(invoice: Invoice): string {
  if (invoice.typeCode !== '380') {
    throw new UnsupportedTypeCodeError(invoice.typeCode)
  }
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_INVOICE, 'Invoice')
    .att('xmlns:cac', NS_CAC)
    .att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  if (invoice.dueDate) root.ele('cbc:DueDate').txt(invoice.dueDate)
  root.ele('cbc:InvoiceTypeCode').txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  addParty(root, 'AccountingSupplierParty', invoice.seller)
  addParty(root, 'AccountingCustomerParty', invoice.buyer)

  appendTaxTotal(root, invoice)

  const totals = root.ele('cac:LegalMonetaryTotal')
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

  for (const line of invoice.lines) {
    const l = root.ele('cac:InvoiceLine')
    l.ele('cbc:ID').txt(line.id)
    l.ele('cbc:InvoicedQuantity')
      .att('unitCode', line.unitCode)
      .txt(line.quantity)
    addAmount(l, 'LineExtensionAmount', line.lineNetAmount, invoice.currency)
    const item = l.ele('cac:Item')
    item.ele('cbc:Name').txt(line.name)
    const taxCategory = item.ele('cac:ClassifiedTaxCategory')
    taxCategory.ele('cbc:ID').txt(line.vatCategory)
    taxCategory.ele('cbc:Percent').txt(line.vatRate)
    taxCategory.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
    const price = l.ele('cac:Price')
    addAmount(price, 'PriceAmount', line.unitPrice, invoice.currency)
  }

  return doc.end({ prettyPrint: true })
}
