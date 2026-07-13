import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'

const NS_RSM = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'
const NS_RAM =
  'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'
const NS_UDT = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100'

// AAAAMMJJ (format 102 des DateTimeString CII).
const ciiDate = (iso: string): string => iso.replace(/-/g, '')

// CII D16B, profil EN 16931 (BR-CO-*, BR-*-10). Sert la facture (380) et l'avoir
// (381) sans changer de racine — le TypeCode est la seule différence portée par
// le modèle canonique (invoice.typeCode).
export function generateCii(invoice: Invoice): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_RSM, 'rsm:CrossIndustryInvoice')
    .att('xmlns:ram', NS_RAM)
    .att('xmlns:udt', NS_UDT)

  // BG-2 : contexte (BT-23 process si présent, BT-24 guideline EN 16931).
  const ctx = root.ele('rsm:ExchangedDocumentContext')
  if (invoice.businessProcessType)
    ctx
      .ele('ram:BusinessProcessSpecifiedDocumentContextParameter')
      .ele('ram:ID')
      .txt(invoice.businessProcessType)
  ctx
    .ele('ram:GuidelineSpecifiedDocumentContextParameter')
    .ele('ram:ID')
    .txt('urn:cen.eu:en16931:2017')

  // BT-1/BT-3/BT-2
  const head = root.ele('rsm:ExchangedDocument')
  head.ele('ram:ID').txt(invoice.number)
  head.ele('ram:TypeCode').txt(invoice.typeCode)
  head
    .ele('ram:IssueDateTime')
    .ele('udt:DateTimeString')
    .att('format', '102')
    .txt(ciiDate(invoice.issueDate))

  const tx = root.ele('rsm:SupplyChainTradeTransaction')

  // BG-25 : lignes
  for (const line of invoice.lines) {
    const li = tx.ele('ram:IncludedSupplyChainTradeLineItem')
    li.ele('ram:AssociatedDocumentLineDocument').ele('ram:LineID').txt(line.id)
    li.ele('ram:SpecifiedTradeProduct').ele('ram:Name').txt(line.name)
    li.ele('ram:SpecifiedLineTradeAgreement')
      .ele('ram:NetPriceProductTradePrice')
      .ele('ram:ChargeAmount')
      .txt(line.unitPrice)
    li.ele('ram:SpecifiedLineTradeDelivery')
      .ele('ram:BilledQuantity')
      .att('unitCode', line.unitCode)
      .txt(line.quantity)
    const lineSettle = li.ele('ram:SpecifiedLineTradeSettlement')
    const lineTax = lineSettle.ele('ram:ApplicableTradeTax')
    lineTax.ele('ram:TypeCode').txt('VAT')
    lineTax.ele('ram:CategoryCode').txt(line.vatCategory)
    lineTax.ele('ram:RateApplicablePercent').txt(line.vatRate)
    lineSettle
      .ele('ram:SpecifiedTradeSettlementLineMonetarySummation')
      .ele('ram:LineTotalAmount')
      .txt(line.lineNetAmount)
  }

  // BG-4/BG-7
  const agreement = tx.ele('ram:ApplicableHeaderTradeAgreement')
  appendCiiParty(agreement, 'ram:SellerTradeParty', invoice.seller)
  appendCiiParty(agreement, 'ram:BuyerTradeParty', invoice.buyer)
  tx.ele('ram:ApplicableHeaderTradeDelivery')

  // BG-22/BG-23
  const settle = tx.ele('ram:ApplicableHeaderTradeSettlement')
  settle.ele('ram:InvoiceCurrencyCode').txt(invoice.currency)
  for (const b of invoice.vatBreakdown) {
    const tax = settle.ele('ram:ApplicableTradeTax')
    tax.ele('ram:CalculatedAmount').txt(b.taxAmount)
    tax.ele('ram:TypeCode').txt('VAT')
    if (b.exemptionReason) tax.ele('ram:ExemptionReason').txt(b.exemptionReason)
    tax.ele('ram:BasisAmount').txt(b.taxableAmount)
    tax.ele('ram:CategoryCode').txt(b.category)
    if (b.exemptionReasonCode)
      tax.ele('ram:ExemptionReasonCode').txt(b.exemptionReasonCode)
    tax.ele('ram:RateApplicablePercent').txt(b.rate)
  }
  const sum = settle.ele('ram:SpecifiedTradeSettlementHeaderMonetarySummation')
  sum.ele('ram:LineTotalAmount').txt(invoice.totals.sumOfLines)
  sum.ele('ram:TaxBasisTotalAmount').txt(invoice.totals.taxExclusive)
  sum
    .ele('ram:TaxTotalAmount')
    .att('currencyID', invoice.currency)
    .txt(invoice.totals.taxAmount)
  sum.ele('ram:GrandTotalAmount').txt(invoice.totals.taxInclusive)
  sum.ele('ram:DuePayableAmount').txt(invoice.totals.payable)

  return doc.end({ prettyPrint: true })
}

function appendCiiParty(
  parent: XMLBuilder,
  role: 'ram:SellerTradeParty' | 'ram:BuyerTradeParty',
  party: Party,
): void {
  const p = parent.ele(role)
  p.ele('ram:Name').txt(party.name)
  if (party.siren)
    p.ele('ram:SpecifiedLegalOrganization').ele('ram:ID').txt(party.siren)
  const addr = p.ele('ram:PostalTradeAddress')
  if (party.address.postalCode)
    addr.ele('ram:PostcodeCode').txt(party.address.postalCode)
  if (party.address.streetName)
    addr.ele('ram:LineOne').txt(party.address.streetName)
  if (party.address.city) addr.ele('ram:CityName').txt(party.address.city)
  addr.ele('ram:CountryID').txt(party.address.countryCode)
  if (party.vatId) {
    const reg = p.ele('ram:SpecifiedTaxRegistration')
    reg.ele('ram:ID').att('schemeID', 'VA').txt(party.vatId)
  }
}
