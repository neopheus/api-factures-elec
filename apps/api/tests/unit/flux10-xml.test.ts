import { describe, expect, it } from 'vitest'
import type { Flux10Report } from '../../src/ereporting/flux10-model.js'
import { generateEreportingXml } from '../../src/ereporting/flux10-xml.js'
import { validateAgainstEreportingXsd } from '../helpers/ereporting-xsd.js'

const sender = {
  id: 'PA01',
  schemeId: '0238',
  name: 'Factelec PA',
  roleCode: 'WK',
} as const
const issuer = {
  id: '123456789',
  schemeId: '0002',
  name: 'Vendeur SARL',
  roleCode: 'SE',
} as const

// TB-1 + TB-2 avec une transaction agrégée B2C (10.3) minimale XSD-valide.
const report: Flux10Report = {
  document: {
    id: 'TRX-2026-0001',
    issueDateTime: '20260921080000',
    typeCode: 'IN',
    sender,
    issuer,
  },
  transactions: {
    periodStart: '20260901',
    periodEnd: '20260910',
    invoices: [],
    aggregated: [
      {
        date: '20260905',
        currency: 'EUR',
        categoryCode: 'TLB1',
        taxExclusiveAmount: '1000.00',
        taxTotal: '200.00',
        subtotals: [
          { taxPercent: '20.00', taxableAmount: '1000.00', taxTotal: '200.00' },
        ],
      },
    ],
  },
  payments: null,
}

describe('generateEreportingXml', () => {
  it('produit un XML valide contre le XSD DGFiP e-reporting (10.3 agrégé)', () => {
    const xml = generateEreportingXml(report)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('sérialise TB-1 (ReportDocument) obligatoire et TB-2 (période + agrégat)', () => {
    const xml = generateEreportingXml(report)
    expect(xml).toContain('<Report')
    expect(xml).toContain('<ReportDocument>')
    expect(xml).toContain('<TypeCode>IN</TypeCode>')
    expect(xml).toContain('schemeId="0238"')
    expect(xml).toContain('schemeId="0002"')
    expect(xml).toContain('<StartDate>20260901</StartDate>')
    expect(xml).toContain('<EndDate>20260910</EndDate>')
    expect(xml).toContain('<CategoryCode>TLB1</CategoryCode>')
    expect(xml).toContain('<TransactionsCurrency>EUR</TransactionsCurrency>')
  })

  it('sérialise le nom optionnel du document (TT-2) quand fourni', () => {
    const withName: Flux10Report = {
      ...report,
      document: { ...report.document, name: 'Transmission B2C septembre' },
    }
    const xml = generateEreportingXml(withName)
    expect(xml).toContain('<Name>Transmission B2C septembre</Name>')
    expect(validateAgainstEreportingXsd(xml).valid).toBe(true)
  })

  it('sérialise TransactionsCount (TT-85) quand fourni, aucune trace sinon', () => {
    const withCount: Flux10Report = {
      ...report,
      transactions: {
        ...report.transactions!,
        aggregated: [
          { ...report.transactions!.aggregated[0]!, transactionsCount: 12 },
        ],
      },
    }
    const xml = generateEreportingXml(withCount)
    expect(xml).toContain('<TransactionsCount>12</TransactionsCount>')
    expect(validateAgainstEreportingXsd(xml).valid).toBe(true)

    const withoutCount = generateEreportingXml(report)
    expect(withoutCount).not.toContain('TransactionsCount')
  })

  it('sérialise TaxDueDateTypeCode (TT-80) quand fourni, aucune trace sinon', () => {
    const withOption: Flux10Report = {
      ...report,
      transactions: {
        ...report.transactions!,
        aggregated: [
          { ...report.transactions!.aggregated[0]!, taxDueDateTypeCode: 'D' },
        ],
      },
    }
    const xml = generateEreportingXml(withOption)
    expect(xml).toContain('<TaxDueDateTypeCode>D</TaxDueDateTypeCode>')
    expect(validateAgainstEreportingXsd(xml).valid).toBe(true)

    const withoutOption = generateEreportingXml(report)
    expect(withoutOption).not.toContain('TaxDueDateTypeCode')
  })

  it('sérialise plusieurs transactions agrégées et plusieurs sous-totaux TVA', () => {
    const multi: Flux10Report = {
      ...report,
      transactions: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [],
        aggregated: [
          {
            date: '20260902',
            currency: 'EUR',
            categoryCode: 'TLB1',
            taxExclusiveAmount: '500.00',
            taxTotal: '100.00',
            subtotals: [
              {
                taxPercent: '20.00',
                taxableAmount: '500.00',
                taxTotal: '100.00',
              },
            ],
          },
          {
            date: '20260903',
            currency: 'EUR',
            categoryCode: 'TPS1',
            taxExclusiveAmount: '300.00',
            taxTotal: '48.00',
            subtotals: [
              {
                taxPercent: '20.00',
                taxableAmount: '200.00',
                taxTotal: '40.00',
              },
              { taxPercent: '5.50', taxableAmount: '100.00', taxTotal: '8.00' },
            ],
          },
        ],
      },
    }
    const xml = generateEreportingXml(multi)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<CategoryCode>TPS1</CategoryCode>')
  })

  it('échappe les caractères XML dangereux (injection-proof)', () => {
    const r: Flux10Report = {
      ...report,
      document: { ...report.document, issuer: { ...issuer, name: 'A & <B>' } },
    }
    const xml = generateEreportingXml(r)
    expect(xml).toContain('A &amp; &lt;B&gt;')
    expect(xml).not.toContain('<B>')
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('sérialise une forme par facture 10.1 (Invoice/TG-8) XSD-valide, avec et sans pays vendeur', () => {
    const withInvoices: Flux10Report = {
      document: report.document,
      transactions: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            id: 'INV-0001',
            issueDate: '20260905',
            typeCode: '380',
            currency: 'EUR',
            businessProcessId: 'B1',
            businessProcessTypeId: 'e-reporting',
            seller: {
              companyId: '123456789',
              schemeId: '0002',
              countryId: 'FR',
            },
            taxAmount: '200.00',
            taxSubTotals: [
              {
                taxableAmount: '1000.00',
                taxAmount: '200.00',
                categoryCode: 'S',
                percent: '20.00',
              },
            ],
          },
          {
            id: 'INV-0002',
            issueDate: '20260906',
            typeCode: '380',
            currency: 'EUR',
            businessProcessId: 'S1',
            businessProcessTypeId: 'e-reporting',
            seller: { companyId: '987654321', schemeId: '0002' },
            taxAmount: '40.00',
            taxSubTotals: [
              { taxableAmount: '200.00', taxAmount: '40.00', percent: '20.00' },
            ],
          },
        ],
        aggregated: [],
      },
      payments: null,
    }
    const xml = generateEreportingXml(withInvoices)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<ID>INV-0001</ID>')
    expect(xml).toContain('<CountryId>FR</CountryId>')
    expect(xml).toContain('<Code>S</Code>')
  })

  it('sérialise une forme TB-3 PaymentsReport structurelle XSD-valide (10.2 per-facture, D7)', () => {
    const withPayments: Flux10Report = {
      document: report.document,
      transactions: null,
      payments: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            invoiceId: 'INV-0001',
            issueDate: '20260905',
            paymentDate: '20260915',
            subtotals: [
              { taxPercent: '20.00', currency: 'EUR', amount: '200.00' },
              { taxPercent: '5.50', amount: '10.00' },
            ],
          },
        ],
        transactions: [],
      },
    }
    const xml = generateEreportingXml(withPayments)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<PaymentsReport>')
    expect(xml).toContain('<InvoiceID>INV-0001</InvoiceID>')
    expect(xml).toContain('<CurrencyCode>EUR</CurrencyCode>')
  })

  it('sérialise une forme TB-3 agrégée (10.4, /PaymentsReport/Transactions, TG-37) XSD-valide : Payment/Date + SubTotals par taux', () => {
    const withAggregatedPayments: Flux10Report = {
      document: report.document,
      transactions: null,
      payments: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [],
        transactions: [
          {
            paymentDate: '20260920',
            subtotals: [
              { taxPercent: '20.00', currency: 'EUR', amount: '450.00' },
              { taxPercent: '5.50', amount: '10.00' },
            ],
          },
        ],
      },
    }
    const xml = generateEreportingXml(withAggregatedPayments)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<PaymentsReport>')
    expect(xml).toContain('<Transactions>')
    expect(xml).toContain('<Date>20260920</Date>')
    expect(xml).not.toContain('InvoiceID')
  })

  it('coexistence 10.2 (invoices[]) + 10.4 (transactions[]) dans le MÊME PaymentsReport, XSD-valide (séquence XSD permissive)', () => {
    const mixedPayments: Flux10Report = {
      document: report.document,
      transactions: null,
      payments: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            invoiceId: 'INV-0001',
            issueDate: '20260905',
            paymentDate: '20260915',
            subtotals: [{ taxPercent: '20.00', amount: '200.00' }],
          },
        ],
        transactions: [
          {
            paymentDate: '20260920',
            subtotals: [{ taxPercent: '20.00', amount: '450.00' }],
          },
        ],
      },
    }
    const xml = generateEreportingXml(mixedPayments)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<InvoiceID>INV-0001</InvoiceID>')
    expect(xml).toContain('<Transactions>')
  })

  it("n'émet PAS de <CurrencyCode/> vide quand la devise est absente, sur les DEUX formes (garde 0..1, classe 2.4-I1)", () => {
    const withoutCurrency: Flux10Report = {
      document: report.document,
      transactions: null,
      payments: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            invoiceId: 'INV-0001',
            issueDate: '20260905',
            paymentDate: '20260915',
            subtotals: [{ taxPercent: '20.00', amount: '200.00' }],
          },
        ],
        transactions: [
          {
            paymentDate: '20260920',
            subtotals: [{ taxPercent: '20.00', amount: '450.00' }],
          },
        ],
      },
    }
    const xml = generateEreportingXml(withoutCurrency)
    expect(xml).not.toContain('<CurrencyCode/>')
    expect(xml).not.toContain('<CurrencyCode></CurrencyCode>')
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it("formate les montants encaissés en MONTANT 19.6 (6 décimales) à l'émission, sur les DEUX formes (TT-95/TT-99, D7)", () => {
    const captured2dp: Flux10Report = {
      document: report.document,
      transactions: null,
      payments: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            invoiceId: 'INV-0001',
            issueDate: '20260905',
            paymentDate: '20260915',
            subtotals: [{ taxPercent: '20.00', amount: '200.00' }],
          },
        ],
        transactions: [
          {
            paymentDate: '20260920',
            subtotals: [{ taxPercent: '20.00', amount: '450.00' }],
          },
        ],
      },
    }
    const xml = generateEreportingXml(captured2dp)
    expect(xml).toContain('<Amount>200.000000</Amount>')
    expect(xml).toContain('<Amount>450.000000</Amount>')
    expect(xml).not.toContain('<Amount>200.00</Amount>')
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  // Injection revue T3 (THIN 2, à solder Task 7) : un rapport dont
  // companyId='' ET businessProcessId='' traverse RÉELLEMENT la validation
  // XSD (transaction.xsd, via ereporting.xsd) — jamais seulement affirmé.
  it("xmllint-valide les fallbacks vides (companyId='' ET businessProcessId='') sur une Invoice 10.1 (injection revue T3, THIN 2)", () => {
    const emptyFallbacks: Flux10Report = {
      document: report.document,
      transactions: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            id: 'INV-0003',
            issueDate: '20260907',
            typeCode: '380',
            currency: 'EUR',
            businessProcessId: '',
            businessProcessTypeId: 'e-reporting',
            seller: { companyId: '', schemeId: '0002' },
            taxAmount: '0.00',
            taxSubTotals: [
              { taxableAmount: '0.00', taxAmount: '0.00', percent: '0.00' },
            ],
          },
        ],
        aggregated: [],
      },
      payments: null,
    }
    const xml = generateEreportingXml(emptyFallbacks)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('schemeId="0002"')
  })

  // Injection revue T3 (THIN 3, à solder Task 7) : un TransactionsReport
  // MIXTE (invoices[] 10.1 ET aggregated[] 10.3 non vides SIMULTANÉMENT) est
  // XSD-valide — jamais prouvé par xmllint jusqu'ici (la séquence XSD
  // autorise Invoice(0..n) PUIS Transactions(0..n) dans TransactionsReportType).
  it('xmllint-valide un TransactionsReport MIXTE : invoices[] (10.1) ET aggregated[] (10.3) non vides simultanément (injection revue T3, THIN 3)', () => {
    const mixedTransactions: Flux10Report = {
      document: report.document,
      transactions: {
        periodStart: '20260901',
        periodEnd: '20260910',
        invoices: [
          {
            id: 'INV-0004',
            issueDate: '20260908',
            typeCode: '380',
            currency: 'EUR',
            businessProcessId: 'B1',
            businessProcessTypeId: 'e-reporting',
            seller: {
              companyId: '123456789',
              schemeId: '0002',
              countryId: 'FR',
            },
            taxAmount: '200.00',
            taxSubTotals: [
              {
                taxableAmount: '1000.00',
                taxAmount: '200.00',
                categoryCode: 'S',
                percent: '20.00',
              },
            ],
          },
        ],
        aggregated: [
          {
            date: '20260905',
            currency: 'EUR',
            categoryCode: 'TLB1',
            taxExclusiveAmount: '1000.00',
            taxTotal: '200.00',
            subtotals: [
              {
                taxPercent: '20.00',
                taxableAmount: '1000.00',
                taxTotal: '200.00',
              },
            ],
          },
        ],
      },
      payments: null,
    }
    const xml = generateEreportingXml(mixedTransactions)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<ID>INV-0004</ID>')
    expect(xml).toContain('<CategoryCode>TLB1</CategoryCode>')
  })

  it('ne sérialise ni TransactionsReport ni PaymentsReport si les deux sont absents', () => {
    const bare: Flux10Report = {
      document: report.document,
      transactions: null,
      payments: null,
    }
    const xml = generateEreportingXml(bare)
    expect(xml).not.toContain('<TransactionsReport>')
    expect(xml).not.toContain('<PaymentsReport>')
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })
})
