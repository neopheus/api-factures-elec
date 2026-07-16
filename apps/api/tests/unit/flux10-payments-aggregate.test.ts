import type { Invoice } from '@factelec/invoice-core'
import { buildInvoice } from '@factelec/invoice-core'
import { describe, expect, it } from 'vitest'
import type { Flux10Report } from '../../src/ereporting/flux10-model.js'
import { aggregatePayments } from '../../src/ereporting/flux10-payments-aggregate.js'
import { generateEreportingXml } from '../../src/ereporting/flux10-xml.js'
import type { PaymentRow } from '../../src/payments/payments.repository.js'
import { validateAgainstEreportingXsd } from '../helpers/ereporting-xsd.js'

// Facture par défaut : acheteur FR sans identifiant d'assujetti (SIREN/TVA)
// -> B2C domestique (10.3), le cas nominal agrégé (10.4). Toutes les lignes
// sont 'services' par défaut (le cas nominal de la règle services-only, note
// 119) — les tests dédiés ci-dessous couvrent biens/mixte/incomplet.
const inv = (over: Record<string, unknown>): Invoice =>
  buildInvoice({
    number: 'FAC-1',
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
        nature: 'services',
      },
    ],
    ...over,
  } as never)

const paymentRow = (over: Partial<PaymentRow>): PaymentRow => ({
  id: 'pay-1',
  invoiceId: 'inv-1',
  paymentDate: '20260915',
  currency: 'EUR',
  reference: 'REF-1',
  subtotals: [{ taxPercent: '20.00', amount: '200.00' }],
  createdAt: new Date('2026-09-15T00:00:00Z'),
  updatedAt: new Date('2026-09-15T00:00:00Z'),
  ...over,
})

function loaderFor(byId: Record<string, Invoice>) {
  return async (invoiceId: string): Promise<Invoice | null> =>
    byId[invoiceId] ?? null
}

const opts = { periodStart: '20260901', periodEnd: '20260930' }

describe('aggregatePayments — TB-3 (10.2 per-facture / 10.4 agrégé, services-only)', () => {
  it('classe un encaissement B2Bi (assujetti étranger) en Flux10PaymentInvoice per-facture (10.2), invoiceId = numéro de facture', async () => {
    const invoice = inv({
      number: 'FAC-B2BI-1',
      buyer: {
        name: 'B',
        vatId: 'DE123456789',
        address: { countryCode: 'DE' },
      },
    })
    const row = paymentRow({ invoiceId: 'inv-1' })
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': invoice }),
    })

    expect(report?.transactions).toEqual([])
    expect(report?.invoices).toEqual([
      {
        invoiceId: 'FAC-B2BI-1',
        issueDate: '20260905',
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '200.00', currency: 'EUR' }],
      },
    ])
  })

  it('agrège un encaissement B2C (acheteur non-assujetti) par (date, taux) — 10.3/10.4, sans réf facture ni catégorie', async () => {
    const invoice = inv({})
    const row = paymentRow({})
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': invoice }),
    })

    expect(report?.invoices).toEqual([])
    expect(report?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '200.00', currency: 'EUR' }],
      },
    ])
  })

  it('fusionne (big.js) plusieurs encaissements B2C de factures DIFFÉRENTES au même (date, taux) dans le MÊME bucket agrégé', async () => {
    const invoiceA = inv({ number: 'FAC-B2C-A' })
    const invoiceB = inv({ number: 'FAC-B2C-B' })
    const rowA = paymentRow({
      id: 'pay-A',
      invoiceId: 'inv-A',
      reference: 'REF-A',
      subtotals: [{ taxPercent: '20.00', amount: '300.00' }],
    })
    const rowB = paymentRow({
      id: 'pay-B',
      invoiceId: 'inv-B',
      reference: 'REF-B',
      subtotals: [{ taxPercent: '20.00', amount: '150.00' }],
    })
    const report = await aggregatePayments([rowA, rowB], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-A': invoiceA, 'inv-B': invoiceB }),
    })

    // Oracle indépendant : 300.00 + 150.00 = 450.00 (calculé à la main).
    expect(report?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '450.00', currency: 'EUR' }],
      },
    ])
  })

  it("applique la maille déclarant via filterInvoice : l'encaissement d'une facture d'un AUTRE déclarant est exclu SILENCIEUSEMENT (revue T8, MAJOR-1)", async () => {
    // Tenant à 2 déclarants : la facture du siren 111111111 ne doit compter
    // QUE pour le rapport du déclarant 111111111 — jamais pour l'autre.
    const invoiceOfDeclarantA = inv({
      number: 'FAC-DECL-A',
      seller: {
        name: 'V',
        siren: '111111111',
        address: { countryCode: 'FR' },
      },
    })
    const row = paymentRow({ invoiceId: 'inv-A' })
    const forDeclarantB = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-A': invoiceOfDeclarantA }),
      filterInvoice: (invoice) => invoice.seller.siren === '999999999',
    })
    // Rien d'e-reportable pour B → rapport nul (à blanc), pas de fuite
    // de l'encaissement de A.
    expect(forDeclarantB).toBeNull()

    const forDeclarantA = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-A': invoiceOfDeclarantA }),
      filterInvoice: (invoice) => invoice.seller.siren === '111111111',
    })
    expect(forDeclarantA?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '200.00', currency: 'EUR' }],
      },
    ])
  })

  it("agrège l'encaissement d'un export B2C (vendeur FR, particulier étranger) dans le 10.4 domestique et exerce la branche d'audit (revue T7, LOW/nit)", async () => {
    // Même repli que côté transactions (D4/T3) : le particulier ÉTRANGER est
    // classé 10.3 → agrégé en 10.4, tracé par le compteur/warn d'audit
    // (interprétation à confirmer Annexe 7, go-live).
    const exportB2C = inv({
      number: 'FAC-EXPORT-DE',
      buyer: { name: 'Privatperson DE', address: { countryCode: 'DE' } },
    })
    const domestic = inv({ number: 'FAC-B2C-FR' })
    const rowExport = paymentRow({
      id: 'pay-DE',
      invoiceId: 'inv-DE',
      reference: 'REF-DE',
      subtotals: [{ taxPercent: '20.00', amount: '120.00' }],
    })
    const rowDomestic = paymentRow({
      id: 'pay-FR',
      invoiceId: 'inv-FR',
      reference: 'REF-FR',
      subtotals: [{ taxPercent: '20.00', amount: '80.00' }],
    })
    const report = await aggregatePayments([rowExport, rowDomestic], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-DE': exportB2C, 'inv-FR': domestic }),
    })

    // Oracle indépendant : fusion RÉELLE export + domestique (même date,
    // taux, devise) = 120.00 + 80.00 = 200.00 — jamais émis en 10.2.
    expect(report?.invoices).toEqual([])
    expect(report?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '200.00', currency: 'EUR' }],
      },
    ])
  })

  it('NE fusionne PAS deux encaissements même (date, taux) en devises DIFFÉRENTES — la devise fait partie de la clé (revue T7, MEDIUM-1)', async () => {
    const invoiceEur = inv({ number: 'FAC-B2C-EUR' })
    const invoiceUsd = inv({ number: 'FAC-B2C-USD', currency: 'USD' })
    const rowEur = paymentRow({
      id: 'pay-EUR',
      invoiceId: 'inv-EUR',
      reference: 'REF-EUR',
      currency: 'EUR',
      subtotals: [{ taxPercent: '20.00', amount: '300.00' }],
    })
    const rowUsd = paymentRow({
      id: 'pay-USD',
      invoiceId: 'inv-USD',
      reference: 'REF-USD',
      currency: 'USD',
      subtotals: [{ taxPercent: '20.00', amount: '150.00' }],
    })
    const report = await aggregatePayments([rowEur, rowUsd], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-EUR': invoiceEur, 'inv-USD': invoiceUsd }),
    })

    // Oracle indépendant : DEUX sous-totaux distincts (300.00 EUR, 150.00
    // USD), JAMAIS 450.00 sous une devise unique — sommer des devises
    // différentes fausserait la figure réglementaire.
    expect(report?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [
          { taxPercent: '20.00', amount: '300.00', currency: 'EUR' },
          { taxPercent: '20.00', amount: '150.00', currency: 'USD' },
        ],
      },
    ])
  })

  it('fusionne des taux de FORMES différentes mais de même VALEUR (« 20.0 » vs « 20.00 ») dans le même sous-total (revue T7, LOW — clé normalisée)', async () => {
    const invoiceA = inv({ number: 'FAC-B2C-F1' })
    const invoiceB = inv({
      number: 'FAC-B2C-F2',
      lines: [
        {
          id: '1',
          name: 'x',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '100.00',
          vatCategory: 'S',
          vatRate: '20.0',
          nature: 'services',
        },
      ],
    })
    const rowA = paymentRow({
      id: 'pay-F1',
      invoiceId: 'inv-F1',
      reference: 'REF-F1',
      subtotals: [{ taxPercent: '20.00', amount: '100.00' }],
    })
    const rowB = paymentRow({
      id: 'pay-F2',
      invoiceId: 'inv-F2',
      reference: 'REF-F2',
      subtotals: [{ taxPercent: '20.0', amount: '50.00' }],
    })
    const report = await aggregatePayments([rowA, rowB], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-F1': invoiceA, 'inv-F2': invoiceB }),
    })

    // Oracle indépendant : 100.00 + 50.00 = 150.00, UN seul sous-total (la
    // forme émise est celle du premier rencontré : « 20.00 »).
    expect(report?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '150.00', currency: 'EUR' }],
      },
    ])
  })

  it("exclut un encaissement lié à une facture classée 'out' (B2B domestique, e-invoicing) ; renvoie null si rien d'imposable", async () => {
    const domesticB2B = inv({
      seller: { name: 'V', siren: '123456789', address: { countryCode: 'FR' } },
      buyer: { name: 'B', siren: '987654321', address: { countryCode: 'FR' } },
    })
    const row = paymentRow({})
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': domesticB2B }),
    })
    expect(report).toBeNull()
  })

  it("renvoie null quand la liste d'encaissements est vide", async () => {
    const report = await aggregatePayments([], {
      ...opts,
      loadInvoice: loaderFor({}),
    })
    expect(report).toBeNull()
  })

  // Bannière SERVICES-ONLY (§3.7.4 note 119, revue A-T7-1, BINDING, VERBATIM) :
  // « Les données de paiement ne doivent être transmises qu'en cas de
  // prestations de services, hors opérations donnant lieu à autoliquidation de
  // la TVA et option de TVA sur les débits. »
  describe('règle SERVICES-ONLY (note 119) — filtre biens exclus, proratisation mixte, différé si indécidable', () => {
    it('exclut INTÉGRALEMENT un encaissement lié à une facture 100% biens (aucun sous-total résiduel, aucune fabrication)', async () => {
      const goodsOnly = inv({
        lines: [
          {
            id: '1',
            name: 'x',
            quantity: '1',
            unitCode: 'C62',
            unitPrice: '1000.00',
            vatCategory: 'S',
            vatRate: '20.00',
            nature: 'goods',
          },
        ],
      })
      const row = paymentRow({})
      const report = await aggregatePayments([row], {
        ...opts,
        loadInvoice: loaderFor({ 'inv-1': goodsOnly }),
      })
      expect(report).toBeNull()
    })

    it('proratise un encaissement MIXTE biens/services par taux (part réelle des services, oracle calculé à la main)', async () => {
      // Ventilation canonique (une seule ligne 20% après regroupement
      // catégorie/taux) : taxable 1000.00, taxe 200.00 -> TTC 1200.00.
      // computeVatBreakdownByNature : goods (600.00 net) -> taxable 600.00,
      // taxe 120.00 (20% exact) -> TTC 720.00. services dérivé par
      // soustraction : taxable 400.00, taxe 80.00 -> TTC 480.00.
      // ratio(20%) = 480.00 / 1200.00 = 0.4 (EXACT, calculé à la main).
      // Encaissement capturé au taux 20% : 900.00 -> part services attendue
      // = 900.00 * 0.4 = 360.00 (EXACT, calculé à la main).
      const mixed = inv({
        lines: [
          {
            id: '1',
            name: 'biens',
            quantity: '1',
            unitCode: 'C62',
            unitPrice: '600.00',
            vatCategory: 'S',
            vatRate: '20.00',
            nature: 'goods',
          },
          {
            id: '2',
            name: 'services',
            quantity: '1',
            unitCode: 'C62',
            unitPrice: '400.00',
            vatCategory: 'S',
            vatRate: '20.00',
            nature: 'services',
          },
        ],
      })
      const row = paymentRow({
        subtotals: [{ taxPercent: '20.00', amount: '900.00' }],
      })
      const report = await aggregatePayments([row], {
        ...opts,
        loadInvoice: loaderFor({ 'inv-1': mixed }),
      })
      expect(report?.transactions).toEqual([
        {
          paymentDate: '20260915',
          subtotals: [
            { taxPercent: '20.00', amount: '360.00', currency: 'EUR' },
          ],
        },
      ])
    })

    it('DIFFÈRE (jamais de fabrication) un encaissement lié à une facture à nature de ligne INCOMPLÈTE', async () => {
      const partiallyNatured = inv({
        lines: [
          {
            id: '1',
            name: 'biens',
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
            // nature ABSENTE délibérément : cas indécidable (D3).
          },
        ],
      })
      const row = paymentRow({})
      const report = await aggregatePayments([row], {
        ...opts,
        loadInvoice: loaderFor({ 'inv-1': partiallyNatured }),
      })
      expect(report).toBeNull()
    })

    it('exclut la part AUTOLIQUIDATION (AE) de la ventilation services (note 119, "hors autoliquidation")', async () => {
      // Ventilation canonique : catégorie AE, taux 20% -> taxable 1000.00,
      // taxe 200.00 -> TTC 1200.00. Toutes les lignes sont 'services' (nature
      // complète), MAIS la catégorie AE est exclue du numérateur (autoliquidation,
      // note 119) -> ratio(20%) = 0 -> encaissement intégralement exclu, comme
      // un cas 100% biens (oracle calculé à la main : 0/1200 = 0).
      const reverseCharge = inv({
        lines: [
          {
            id: '1',
            name: 'prestation en autoliquidation',
            quantity: '1',
            unitCode: 'C62',
            unitPrice: '1000.00',
            vatCategory: 'AE',
            vatRate: '20.00',
            nature: 'services',
            exemptionReasonCode: 'VATEX-EU-AE',
          },
        ],
      })
      const row = paymentRow({})
      const report = await aggregatePayments([row], {
        ...opts,
        loadInvoice: loaderFor({ 'inv-1': reverseCharge }),
      })
      expect(report).toBeNull()
    })
  })

  it("neutralise le ratio (défensif, sans NaN) quand le TTC canonique d'un taux est nul (ligne à 0.00, div/0 évitée)", async () => {
    // Ligne à 0.00 -> vatBreakdown : taxable 0.00, taxe 0.00 -> TTC(20%) = 0.
    // Oracle calculé à la main : ratio = 0 / 0 -> garde défensive -> 0 (jamais
    // NaN/Infinity) -> encaissement exclu, comme un cas 100% biens.
    const zeroValued = inv({
      lines: [
        {
          id: '1',
          name: 'ligne gratuite',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '0.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'services',
        },
      ],
    })
    const row = paymentRow({
      subtotals: [{ taxPercent: '20.00', amount: '50.00' }],
    })
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': zeroValued }),
    })
    expect(report).toBeNull()
  })

  it('exclut (ratio 0 défensif) un sous-total capturé à un TAUX ABSENT de la ventilation de la facture liée (anomalie amont, jamais fabriqué)', async () => {
    const invoice = inv({}) // ventilation : SEUL le taux 20.00 existe
    const row = paymentRow({
      subtotals: [
        { taxPercent: '20.00', amount: '200.00' }, // connu -> retenu
        { taxPercent: '5.50', amount: '10.00' }, // inconnu -> exclu
      ],
    })
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': invoice }),
    })
    expect(report?.transactions).toEqual([
      {
        paymentDate: '20260915',
        subtotals: [{ taxPercent: '20.00', amount: '200.00', currency: 'EUR' }],
      },
    ])
  })

  it("exclut un sous-total dont la part services, non nulle mais infime, s'arrondit à 0.00 (oracle calculé à la main)", async () => {
    // Ventilation canonique (une ligne 20% après regroupement) : taxable
    // 1000000.00, taxe 200000.00 -> TTC 1200000.00. goods (999999.00 net) ->
    // taxable 999999.00, taxe 999999.00*0.20 = 199999.80 (exact) -> TTC
    // 999999.00+199999.80 = 1199998.80. services dérivé par soustraction :
    // taxable 1000000.00-999999.00 = 1.00, taxe 200000.00-199999.80 = 0.20
    // -> TTC 1.20. ratio(20%) = 1.20 / 1200000.00 = 0.000001 (EXACT).
    // Encaissement capturé au taux 20% : 100.00 -> part services
    // = 100.00 * 0.000001 = 0.0001 -> arrondie (2 décimales) à 0.00 -> exclue
    // (aucun sous-total à 0.00 fabriqué), bien que le ratio soit NON NUL.
    const almostAllGoods = inv({
      lines: [
        {
          id: '1',
          name: 'biens (quasi-totalité)',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '999999.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'goods',
        },
        {
          id: '2',
          name: 'services (part infime)',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '1.00',
          vatCategory: 'S',
          vatRate: '20.00',
          nature: 'services',
        },
      ],
    })
    const row = paymentRow({
      subtotals: [{ taxPercent: '20.00', amount: '100.00' }],
    })
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': almostAllGoods }),
    })
    expect(report).toBeNull()
  })

  it('ignore silencieusement (log + skip) un encaissement dont la facture liée est introuvable (défensif, jamais un throw)', async () => {
    const row = paymentRow({ invoiceId: 'inv-disparue' })
    const report = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({}),
    })
    expect(report).toBeNull()
  })
})

describe("XOR au niveau Report — un PaymentsReport agrégé s'assemble SANS transactions (TB-2)", () => {
  it('respecte XOR : le Flux10Report produit porte payments, JAMAIS transactions, XSD-valide, sans <TransactionsReport>', async () => {
    const invoice = inv({})
    const row = paymentRow({})
    const paymentsReport = await aggregatePayments([row], {
      ...opts,
      loadInvoice: loaderFor({ 'inv-1': invoice }),
    })
    expect(paymentsReport).not.toBeNull()
    if (!paymentsReport) throw new Error('unreachable')

    const report: Flux10Report = {
      document: {
        id: 'PAY-2026-0001',
        issueDateTime: '20260921080000',
        typeCode: 'IN',
        sender: {
          id: 'PA01',
          schemeId: '0238',
          name: 'Factelec PA',
          roleCode: 'WK',
        },
        issuer: {
          id: '123456789',
          schemeId: '0002',
          name: 'Vendeur SARL',
          roleCode: 'SE',
        },
      },
      transactions: null,
      payments: paymentsReport,
    }

    const xml = generateEreportingXml(report)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    expect(xml).toContain('<PaymentsReport>')
    expect(xml).not.toContain('<TransactionsReport>')
  })
})
