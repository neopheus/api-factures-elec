import { buildInvoice } from '@factelec/invoice-core'
import Big from 'big.js'
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

  it('DIFFÈRE un cadre mixte M1 SANS nature de ligne (régression 2.3-T3) : seul → null', () => {
    // Task 2 (évolution du test 2.3-T3, injection T1(c)) : avec le
    // discriminant `nature` (Task 1), un cadre mixte n'est plus TOUJOURS
    // différé — seulement quand `computeVatBreakdownByNature` le juge
    // incomplet (une ligne au moins sans `nature`). Ici AUCUNE ligne n'a de
    // nature -> toujours différé, JAMAIS agrégé, JAMAIS doublé (aucune
    // fabrication).
    expect(
      aggregateTransactions([inv({ businessProcessType: 'M1' })], {
        periodStart: '20260901',
        periodEnd: '20260910',
      }),
    ).toBeNull()
  })

  it('DIFFÈRE un cadre mixte M1 PARTIELLEMENT naturé (une ligne sans nature) : seul → null', () => {
    // `computeVatBreakdownByNature.complete` exige que TOUTES les lignes
    // portent `nature` -> une seule ligne sans nature suffit à différer toute
    // la facture (skip typé + log ; aucune ventilation partielle fabriquée).
    const partiallyNatured = inv({
      businessProcessType: 'M1',
      lines: [
        {
          id: '1',
          name: 'bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '600.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'goods',
        },
        {
          id: '2',
          name: 'sans nature',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '400.00',
          vatCategory: 'S',
          vatRate: '20.00',
          // nature absente délibérément
        },
      ],
    })
    expect(
      aggregateTransactions([partiallyNatured], {
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

  // Task 2 — le discriminant biens/services de ligne (Task 1,
  // `computeVatBreakdownByNature`) débloque la ventilation RÉELLE des cadres
  // mixtes M1/M2/M4 : total conservé, JAMAIS doublé. Les factures M* SANS
  // nature de ligne complète restent différées (régression 2.3-T3 ci-dessus,
  // conservée à l'identique).
  it('ventile un M1 naturé en 2 agrégats (TLB1 biens + TPS1 services), montants EXACTS, jamais doublés', () => {
    const m1 = inv({
      businessProcessType: 'M1',
      lines: [
        {
          id: '1',
          name: 'bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '600.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'goods',
        },
        {
          id: '2',
          name: 'service',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '400.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'services',
        },
      ],
    })
    const report = aggregateTransactions([m1], {
      periodStart: '20260901',
      periodEnd: '20260910',
    })
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(2)
    const tlb1 = report!.aggregated.find((a) => a.categoryCode === 'TLB1')!
    const tps1 = report!.aggregated.find((a) => a.categoryCode === 'TPS1')!
    expect(tlb1.taxExclusiveAmount).toBe('600.00')
    expect(tlb1.taxTotal).toBe('120.00')
    expect(tlb1.subtotals).toEqual([
      { taxPercent: '20.00', taxableAmount: '600.00', taxTotal: '120.00' },
    ])
    expect(tps1.taxExclusiveAmount).toBe('400.00')
    expect(tps1.taxTotal).toBe('80.00')
    expect(tps1.subtotals).toEqual([
      { taxPercent: '20.00', taxableAmount: '400.00', taxTotal: '80.00' },
    ])
    // Total conservé (jamais doublé) : 600+400 = 1000, 120+80 = 200 — la base
    // et la taxe canoniques de la facture M1, réparties, pas dupliquées.
    const totalBase = new Big(tlb1.taxExclusiveAmount).plus(
      tps1.taxExclusiveAmount,
    )
    expect(totalBase.toFixed(2)).toBe('1000.00')
  })

  it('injection T1(a) : ventile un M1 naturé avec une ligne exonérée (E, 0%) — conservation exacte', () => {
    // Ligne "bien" imposable (S 20%) + ligne "service" exonérée (E 0%, VATEX).
    // Vérifie que la conservation totale tient MÊME quand une des deux
    // natures porte une catégorie de TVA exonérée (bucket (E,0.00) distinct
    // du bucket (S,20.00) — pas de fusion involontaire).
    const m1 = inv({
      businessProcessType: 'M1',
      lines: [
        {
          id: '1',
          name: 'bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '500.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'goods',
        },
        {
          id: '2',
          name: 'service exonéré',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '300.00',
          vatCategory: 'E',
          vatRate: '0.00',
          nature: 'services',
          exemptionReasonCode: 'VATEX-EU-79-C',
        },
      ],
    })
    const report = aggregateTransactions([m1], {
      periodStart: '20260901',
      periodEnd: '20260910',
    })
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(2)
    const tlb1 = report!.aggregated.find((a) => a.categoryCode === 'TLB1')!
    const tps1 = report!.aggregated.find((a) => a.categoryCode === 'TPS1')!
    expect(tlb1.taxExclusiveAmount).toBe('500.00')
    expect(tlb1.taxTotal).toBe('100.00')
    expect(tps1.taxExclusiveAmount).toBe('300.00')
    expect(tps1.taxTotal).toBe('0.00')
    expect(tps1.subtotals).toEqual([
      { taxPercent: '0.00', taxableAmount: '300.00', taxTotal: '0.00' },
    ])
    // Injection T1(b) ratifiée : l'agrégation ne consomme QUE CategoryCode
    // (TLB1/TPS1 forcé par ce module, pas `entry.category` S/E) + montants —
    // aucun champ `exemptionReasonCode`/`exemptionReason` n'existe sur
    // `AggregatedTransaction`/`Flux10SubTotal` (TG-31/TG-32) : l'asymétrie de
    // `computeVatBreakdownByNature` (le bucket `services` dérivé par
    // soustraction ne porte jamais de motif d'exonération, contrairement au
    // bucket `goods` recalculé) est donc SANS CONSÉQUENCE à cette couche.
    expect(Object.keys(tps1.subtotals[0]!)).toEqual([
      'taxPercent',
      'taxableAmount',
      'taxTotal',
    ])
  })

  it('émet un seul agrégat TLB1 pour un M1 tout-biens (services vide, aucun agrégat TPS1)', () => {
    const m1AllGoods = inv({
      businessProcessType: 'M1',
      lines: [
        {
          id: '1',
          name: 'bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '1000.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'goods',
        },
      ],
    })
    const report = aggregateTransactions([m1AllGoods], {
      periodStart: '20260901',
      periodEnd: '20260910',
    })
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1)
    const a = report!.aggregated[0]!
    expect(a.categoryCode).toBe('TLB1')
    expect(a.taxExclusiveAmount).toBe('1000.00')
    expect(a.taxTotal).toBe('200.00')
  })

  it('laisse B1→TLB1 et S1→TPS1 INCHANGÉS (nature de ligne ignorée pour B*/S*, non-régression 2.3)', () => {
    // Cadre B1 (catégorie unique) : même si la ligne porte (à tort) une
    // nature 'services', le cadre B1 route directement vers TLB1 — la
    // ventilation par nature n'est appelée QUE pour les cadres mixtes.
    const b1WithServicesNature = inv({
      businessProcessType: 'B1',
      lines: [
        {
          id: '1',
          name: 'x',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '1000.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'services',
        },
      ],
    })
    const s1WithGoodsNature = inv({
      number: 'FA-S1',
      businessProcessType: 'S1',
      lines: [
        {
          id: '1',
          name: 'x',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '500.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'goods',
        },
      ],
    })
    const report = aggregateTransactions(
      [b1WithServicesNature, s1WithGoodsNature],
      { periodStart: '20260901', periodEnd: '20260910' },
    )
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(2)
    const tlb1 = report!.aggregated.find((a) => a.categoryCode === 'TLB1')!
    const tps1 = report!.aggregated.find((a) => a.categoryCode === 'TPS1')!
    expect(tlb1.taxExclusiveAmount).toBe('1000.00') // B1 -> TLB1, malgré nature 'services'
    expect(tps1.taxExclusiveAmount).toBe('500.00') // S1 -> TPS1, malgré nature 'goods'
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
