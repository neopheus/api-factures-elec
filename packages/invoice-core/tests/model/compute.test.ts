import Big from 'big.js'
import { describe, expect, it } from 'vitest'
import {
  buildInvoice,
  computeVatBreakdownByNature,
} from '../../src/model/compute.js'
import type {
  InvoiceLineInput,
  InvoiceLineNature,
  VatCategory,
} from '../../src/model/schema.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

// Ligne minimale pour les tests de ventilation par nature : un identifiant,
// un net (quantity=1 × unitPrice=net) et un couple (catégorie, taux) — la
// `nature` est portée séparément (D1 : discriminant OPTIONNEL au niveau ligne).
function lineOf(
  id: string,
  net: string,
  nature?: InvoiceLineNature,
  vatCategory: VatCategory = 'S',
  vatRate = '20.00',
): InvoiceLineInput {
  return {
    id,
    name: `Ligne ${id}`,
    quantity: '1',
    unitCode: 'C62',
    unitPrice: net,
    vatCategory,
    vatRate,
    ...(nature ? { nature } : {}),
  }
}

describe('buildInvoice', () => {
  it('computes line net amounts, VAT breakdown and totals for a simple invoice', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    expect(invoice.lines[0]!.lineNetAmount).toBe('1000.00')
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '1000.00',
        taxAmount: '200.00',
      },
    ])
    expect(invoice.totals).toEqual({
      sumOfLines: '1000.00',
      taxExclusive: '1000.00',
      taxAmount: '200.00',
      taxInclusive: '1200.00',
      payable: '1200.00',
    })
  })

  it('groups the VAT breakdown by category and rate', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    // 3 × 19.99 = 59.97 (S 5.50) ; 49.90 (S 20.00) ; 2 × 150.00 = 300.00 (E 0.00)
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'S',
        rate: '5.50',
        taxableAmount: '59.97',
        taxAmount: '3.30',
      },
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '49.90',
        taxAmount: '9.98',
      },
      {
        category: 'E',
        rate: '0.00',
        taxableAmount: '300.00',
        taxAmount: '0.00',
        exemptionReasonCode: 'VATEX-EU-132-1I',
      },
    ])
    expect(invoice.totals).toEqual({
      sumOfLines: '409.87',
      taxExclusive: '409.87',
      taxAmount: '13.28',
      taxInclusive: '423.15',
      payable: '423.15',
    })
  })

  it('returns an invoice that satisfies the full invoice schema', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    expect(invoice.number).toBe('FA-2026-001')
    expect(invoice.seller.name).toBe('AV Digital')
  })

  it('merges lines sharing the same VAT category and rate into one breakdown entry', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      lines: [
        {
          id: '1',
          name: 'Ligne A',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '100.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
        {
          id: '2',
          name: 'Ligne B',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '50.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
      ],
    })
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '150.00',
        taxAmount: '30.00',
      },
    ])
  })

  it('propagates the exemption reason from the line to the VAT breakdown', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const exempt = invoice.vatBreakdown.find((b) => b.category === 'E')
    expect(exempt?.exemptionReasonCode).toBe('VATEX-EU-132-1I')
  })

  it('leaves standard-rate breakdowns without an exemption reason', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const standard = invoice.vatBreakdown.find((b) => b.category === 'S')
    expect(standard?.exemptionReasonCode).toBeUndefined()
    expect(standard?.exemptionReason).toBeUndefined()
  })

  it('strips the exemption reason from a non-exempt category (S) even when the input line carries one', () => {
    // BR-S-10 (EN 16931) interdit un motif d'exonération sur une ventilation S :
    // le moteur ne doit pas propager un motif porté par erreur sur une ligne S/Z/L/M.
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          exemptionReason: 'Motif ne devant pas apparaître (catégorie S)',
        },
      ],
    })
    const standard = invoice.vatBreakdown.find((b) => b.category === 'S')
    expect(standard).not.toHaveProperty('exemptionReason')
    expect(standard).not.toHaveProperty('exemptionReasonCode')
  })

  it('propagates businessProcessType (BT-23) from input to the built invoice', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      businessProcessType: 'S1',
    })
    expect(invoice.businessProcessType).toBe('S1')
  })

  it('propagates a free-text exemption reason when no VATEX code is given', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          vatCategory: 'E',
          vatRate: '0.00',
          exemptionReason: 'Motif exonération sans code VATEX',
        },
      ],
    })
    const exempt = invoice.vatBreakdown.find((b) => b.category === 'E')
    expect(exempt?.exemptionReason).toBe('Motif exonération sans code VATEX')
    expect(exempt?.exemptionReasonCode).toBeUndefined()
  })
})

describe('nature (line-level goods/services discriminator, D1)', () => {
  it('accepts a line WITHOUT nature (retro-compat) and WITH nature', () => {
    expect(() =>
      buildInvoice({ ...simpleInvoiceInput, lines: [lineOf('1', '1000.00')] }),
    ).not.toThrow()
    expect(() =>
      buildInvoice({
        ...simpleInvoiceInput,
        lines: [lineOf('1', '1000.00', 'goods')],
      }),
    ).not.toThrow()
  })

  it('does not add nature to a line built without it (no fabrication on read)', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      lines: [lineOf('1', '1000.00')],
    })
    expect(invoice.lines[0]).not.toHaveProperty('nature')
  })
})

describe('computeVatBreakdownByNature (D2 — total conservé, jamais doublé)', () => {
  it('ventile M1 1000/200 en biens 600/120 + services 400/80, total conservé', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      businessProcessType: 'M1',
      lines: [
        lineOf('1', '600.00', 'goods'),
        lineOf('2', '400.00', 'services'),
      ],
    })
    const { complete, goods, services } = computeVatBreakdownByNature(invoice)
    expect(complete).toBe(true)
    expect(goods).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '600.00',
        taxAmount: '120.00',
      },
    ])
    expect(services).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '400.00',
        taxAmount: '80.00',
      },
    ])
    // Conservation exacte vs la ventilation canonique (jamais doublée : 1000/200, pas 2000/400).
    const canonical = invoice.vatBreakdown[0]!
    expect(
      Number(goods[0]!.taxableAmount) + Number(services[0]!.taxableAmount),
    ).toBeCloseTo(Number(canonical.taxableAmount), 10)
    expect(
      Number(goods[0]!.taxAmount) + Number(services[0]!.taxAmount),
    ).toBeCloseTo(Number(canonical.taxAmount), 10)
  })

  it('absorbs the rounding residual on the services side (goods+services == canonical, to the cent)', () => {
    // Cas inducteur de résidu : taxable 0.09 (biens) / 0.05 (services) à 25 % —
    // arrondi indépendant : round(0.0225)=0.02 + round(0.0125)=0.01 => 0.03,
    // alors que le canonique arrondit round(0.14 × 0.25)=round(0.035)=0.04 (half-up).
    // La ventilation par soustraction absorbe l'écart côté services (0.02, pas 0.01).
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      businessProcessType: 'M1',
      lines: [
        lineOf('1', '0.09', 'goods', 'S', '25.00'),
        lineOf('2', '0.05', 'services', 'S', '25.00'),
      ],
    })
    const canonical = invoice.vatBreakdown[0]!
    expect(canonical).toMatchObject({
      taxableAmount: '0.14',
      taxAmount: '0.04',
    })

    const { complete, goods, services } = computeVatBreakdownByNature(invoice)
    expect(complete).toBe(true)
    expect(goods).toEqual([
      {
        category: 'S',
        rate: '25.00',
        taxableAmount: '0.09',
        taxAmount: '0.02',
      },
    ])
    // Le résidu (+0.01 vs l'arrondi indépendant 0.01) est absorbé ici, côté services.
    expect(services).toEqual([
      {
        category: 'S',
        rate: '25.00',
        taxableAmount: '0.05',
        taxAmount: '0.02',
      },
    ])
    expect(
      Big(goods[0]!.taxableAmount).plus(services[0]!.taxableAmount).toString(),
    ).toBe(canonical.taxableAmount)
    expect(
      Big(goods[0]!.taxAmount).plus(services[0]!.taxAmount).toString(),
    ).toBe(canonical.taxAmount)
  })

  it('returns complete:false as soon as ONE line lacks nature (the consumer defers)', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      businessProcessType: 'M1',
      lines: [
        lineOf('1', '600.00', 'goods'),
        lineOf('2', '400.00'), // pas de nature
      ],
    })
    expect(computeVatBreakdownByNature(invoice)).toEqual({
      complete: false,
      goods: [],
      services: [],
    })
  })

  it('omits the empty bucket (M* tout-biens => services vide)', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      businessProcessType: 'M1',
      lines: [lineOf('1', '600.00', 'goods'), lineOf('2', '400.00', 'goods')],
    })
    const { complete, goods, services } = computeVatBreakdownByNature(invoice)
    expect(complete).toBe(true)
    expect(goods).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '1000.00',
        taxAmount: '200.00',
      },
    ])
    expect(services).toEqual([])
  })

  it('splits multi-rate × multi-nature lines per (category, rate) bucket, including a bucket with NO goods line', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      businessProcessType: 'M2',
      lines: [
        lineOf('1', '600.00', 'goods', 'S', '20.00'),
        lineOf('2', '400.00', 'services', 'S', '20.00'),
        lineOf('3', '100.00', 'services', 'S', '5.50'), // bucket 5,50 % : aucune ligne "goods"
      ],
    })
    const { complete, goods, services } = computeVatBreakdownByNature(invoice)
    expect(complete).toBe(true)
    expect(goods).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '600.00',
        taxAmount: '120.00',
      },
    ])
    expect(services).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '400.00',
        taxAmount: '80.00',
      },
      {
        category: 'S',
        rate: '5.50',
        taxableAmount: '100.00',
        taxAmount: '5.50',
      },
    ])
  })
})
