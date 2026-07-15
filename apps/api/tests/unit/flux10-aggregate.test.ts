import { buildInvoice } from '@factelec/invoice-core'
import { describe, expect, it } from 'vitest'
import {
  aggregateTransactions,
  classifyEreportingOperation,
} from '../../src/ereporting/flux10-aggregate.js'

// Facture par défaut : acheteur FR sans identifiant d'assujetti (SIREN/TVA)
// -> B2C domestique (10.3), le cas nominal agrégé par ce module.
const inv = (over: Record<string, unknown>) =>
  buildInvoice({
    number: 'FA-1',
    issueDate: '2026-09-05',
    typeCode: '380',
    currency: 'EUR',
    businessProcessType: 'B1',
    seller: { name: 'V', siren: '123456789', address: { countryCode: 'FR' } },
    buyer: { name: 'A', address: { countryCode: 'FR' } },
    lines: [
      {
        id: '1',
        name: 'x',
        quantity: '1',
        unitCode: 'C62',
        unitPrice: '1000.00',
        vatCategory: 'S',
        vatRate: '20.00',
      },
    ],
    ...over,
  } as never)

describe('classifyEreportingOperation (amendement A1)', () => {
  it("retourne '10.3' pour un acheteur FR non-assujetti (B2C domestique)", () => {
    expect(classifyEreportingOperation(inv({}))).toBe('10.3')
  })

  it("retourne '10.1' pour une opération transfrontalière (acheteur hors FR)", () => {
    const crossBorderBuyer = inv({
      buyer: { name: 'A', address: { countryCode: 'DE' } },
    })
    expect(classifyEreportingOperation(crossBorderBuyer)).toBe('10.1')
  })

  it("retourne '10.1' pour une opération transfrontalière (vendeur hors FR)", () => {
    const crossBorderSeller = inv({
      seller: {
        name: 'V',
        siren: '123456789',
        address: { countryCode: 'BE' },
      },
    })
    expect(classifyEreportingOperation(crossBorderSeller)).toBe('10.1')
  })

  it("retourne 'out' pour un acheteur FR assujetti (SIREN présent, B2B domestique)", () => {
    const b2bDomestic = inv({
      buyer: {
        name: 'B',
        siren: '987654321',
        address: { countryCode: 'FR' },
      },
    })
    expect(classifyEreportingOperation(b2bDomestic)).toBe('out')
  })

  it("retourne 'out' pour un acheteur FR assujetti (TVA intracommunautaire présente)", () => {
    const b2bDomestic = inv({
      buyer: {
        name: 'B',
        vatId: 'FR12345678901',
        address: { countryCode: 'FR' },
      },
    })
    expect(classifyEreportingOperation(b2bDomestic)).toBe('out')
  })
})

describe('aggregateTransactions (B2C 10.3)', () => {
  it('retourne null pour une période sans opération (transmission à blanc, D6)', () => {
    expect(
      aggregateTransactions([], {
        periodStart: '20260901',
        periodEnd: '20260910',
      }),
    ).toBeNull()
  })

  it('agrège par (date, devise, catégorie) et somme base/TVA par taux', () => {
    const report = aggregateTransactions([inv({}), inv({ number: 'FA-2' })], {
      periodStart: '20260901',
      periodEnd: '20260910',
    })
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1) // même jour/devise/catégorie (B1→TLB1)
    const a = report!.aggregated[0]!
    expect(a.categoryCode).toBe('TLB1')
    expect(a.date).toBe('20260905')
    expect(a.taxExclusiveAmount).toBe('2000.00')
    expect(a.taxTotal).toBe('400.00')
    expect(a.subtotals).toEqual([
      { taxPercent: '20.00', taxableAmount: '2000.00', taxTotal: '400.00' },
    ])
  })

  it('DIFFÈRE un cadre mixte M1 (aucune ventilation LB/PS constructible) : seul → null', () => {
    // Revue Task 3 (bloqueur) : dupliquer le vatBreakdown sur TLB1 ET TPS1
    // DOUBLERAIT la base déclarée (1000/200 → 2000/400). Sans discriminant
    // biens/services par ligne dans le modèle, les cadres mixtes sont différés
    // (comme 10.1/TB-3) — jamais agrégés, jamais doublés.
    expect(
      aggregateTransactions([inv({ businessProcessType: 'M1' })], {
        periodStart: '20260901',
        periodEnd: '20260910',
      }),
    ).toBeNull()
  })

  it('ne compte RIEN d’une facture M1 différée (montants non doublés, base conservée)', () => {
    const report = aggregateTransactions(
      [inv({}), inv({ number: 'FA-M1', businessProcessType: 'M1' })],
      { periodStart: '20260901', periodEnd: '20260910' },
    )
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1) // seule la B1 ; ni TPS1, ni double TLB1
    const a = report!.aggregated[0]!
    expect(a.categoryCode).toBe('TLB1')
    // Montants = la seule facture B1 (1000/200) — la M1 ne contribue à rien.
    expect(a.taxExclusiveAmount).toBe('1000.00')
    expect(a.taxTotal).toBe('200.00')
    expect(a.subtotals).toEqual([
      { taxPercent: '20.00', taxableAmount: '1000.00', taxTotal: '200.00' },
    ])
  })

  it("EXCLUT une facture 'out' (B2B domestique) de l'agrégat 10.3", () => {
    const b2c = inv({})
    const b2bDomestic = inv({
      number: 'FA-B2B',
      buyer: {
        name: 'B',
        siren: '987654321',
        address: { countryCode: 'FR' },
      },
    })
    const report = aggregateTransactions([b2c, b2bDomestic], {
      periodStart: '20260901',
      periodEnd: '20260910',
    })
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1)
    const a = report!.aggregated[0]!
    // Seule la facture 10.3 (b2c) est comptée : 1000.00 base, pas 2000.00.
    expect(a.taxExclusiveAmount).toBe('1000.00')
    expect(a.taxTotal).toBe('200.00')
  })

  it("EXCLUT une facture '10.1' (transfrontalière) de l'agrégat 10.3", () => {
    const b2c = inv({})
    const crossBorder = inv({
      number: 'FA-10-1',
      buyer: { name: 'A', address: { countryCode: 'DE' } },
    })
    const report = aggregateTransactions([b2c, crossBorder], {
      periodStart: '20260901',
      periodEnd: '20260910',
    })
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1)
    const a = report!.aggregated[0]!
    expect(a.taxExclusiveAmount).toBe('1000.00')
    expect(a.taxTotal).toBe('200.00')
    expect(report?.invoices).toEqual([]) // 10.1 non émis dans ce plan (différé)
  })

  it("retourne null quand SEULES des factures 'out'/10.1 sont fournies (aucune 10.3)", () => {
    const b2bDomestic = inv({
      buyer: {
        name: 'B',
        siren: '987654321',
        address: { countryCode: 'FR' },
      },
    })
    const crossBorder = inv({
      number: 'FA-10-1',
      buyer: { name: 'A', address: { countryCode: 'DE' } },
    })
    expect(
      aggregateTransactions([b2bDomestic, crossBorder], {
        periodStart: '20260901',
        periodEnd: '20260910',
      }),
    ).toBeNull()
  })

  it('applique la catégorie par défaut TLB1 quand BT-23 (cadre de facturation) est absent', () => {
    const report = aggregateTransactions(
      [inv({ businessProcessType: undefined })],
      { periodStart: '20260901', periodEnd: '20260910' },
    )
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1)
    expect(report?.aggregated[0]?.categoryCode).toBe('TLB1')
  })

  it('invariant : chaque AggregatedTransaction émis a >= 1 subtotal (XSD minOccurs=1)', () => {
    const report = aggregateTransactions(
      [inv({ businessProcessType: 'M1' }), inv({ number: 'FA-2' })],
      { periodStart: '20260901', periodEnd: '20260910' },
    )
    expect(report).not.toBeNull()
    expect(report!.aggregated.length).toBeGreaterThan(0)
    for (const agg of report!.aggregated) {
      expect(agg.subtotals.length).toBeGreaterThanOrEqual(1)
    }
  })
})
