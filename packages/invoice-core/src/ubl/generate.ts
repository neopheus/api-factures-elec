import { create } from 'xmlbuilder2'
import type { Invoice } from '../model/schema.js'
import {
  appendCommercialParty,
  appendItemAndPrice,
  appendLegalMonetaryTotal,
  appendTaxTotal,
  NS_CAC,
  NS_CBC,
  NS_INVOICE,
} from './common.js'
import { generateCreditNote } from './generate-credit-note.js'

export function generateUbl(invoice: Invoice): string {
  if (invoice.typeCode === '381') return generateCreditNote(invoice)

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_INVOICE, 'Invoice')
    .att('xmlns:cac', NS_CAC)
    .att('xmlns:cbc', NS_CBC)

  // BT-24 (CustomizationID) : ni l'Annexe 1 (Flux 1, specs externes v3.2) ni le
  // Dossier général FE/Chorus Pro ne prescrivent de CIUS-FR (recherche tâche 6,
  // aucun `urn:` ni « CIUS » trouvé hors la seule mention nue « BT-24 »). Décision
  // par défaut : rester sur `urn:cen.eu:en16931:2017`, seule valeur validée par le
  // Schematron officiel (docs/reference/en16931-schematron/). À revoir si la DGFiP
  // publie un jour un CIUS-FR dédié.
  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  // cbc:ProfileID (BT-23, cadre de facturation) : optionnel en EN 16931 pur,
  // émis seulement si businessProcessType est renseigné (le CII l'émet déjà,
  // cf. cii/generate.ts, et les extraits de flux F1 le rendent obligatoire).
  if (invoice.businessProcessType)
    root.ele('cbc:ProfileID').txt(invoice.businessProcessType)
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  if (invoice.dueDate) root.ele('cbc:DueDate').txt(invoice.dueDate)
  root.ele('cbc:InvoiceTypeCode').txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  appendCommercialParty(root, 'AccountingSupplierParty', invoice.seller)
  appendCommercialParty(root, 'AccountingCustomerParty', invoice.buyer)
  appendTaxTotal(root, invoice)
  appendLegalMonetaryTotal(root, invoice)

  for (const line of invoice.lines) {
    const l = root.ele('cac:InvoiceLine')
    l.ele('cbc:ID').txt(line.id)
    l.ele('cbc:InvoicedQuantity')
      .att('unitCode', line.unitCode)
      .txt(line.quantity)
    l.ele('cbc:LineExtensionAmount')
      .att('currencyID', invoice.currency)
      .txt(line.lineNetAmount)
    appendItemAndPrice(l, line, invoice.currency)
  }

  return doc.end({ prettyPrint: true })
}
