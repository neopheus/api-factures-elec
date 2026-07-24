import { readFileSync } from 'node:fs'
import type { OrderMappingPayload } from '@factelec/connectors-sdk'
import type { ErrorObject } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import type { SellerConfig } from '../src/config.js'
import {
  formatDecimal4,
  mapOrder,
  OrderMappingError,
  type ShopifyOrder,
  type ShopifyTaxLine,
} from '../src/order-mapper.js'

// Les MÊMES fixtures que @factelec/connectors-sdk (pas une copie locale —
// motif OrderMapperTest.php WooCommerce/PrestaShop) : toute dérive entre ce
// mapper et le contrat sdk casse ce test immédiatement. `OrderMappingPayload`
// (type sdk réel) plutôt que `any` : les fixtures SONT structurellement des
// payloads de ce type — pas de copie locale du contrat.
const SDK_FIXTURES_DIR = new URL(
  '../../../packages/connectors-sdk/fixtures/',
  import.meta.url,
)
const SDK_SCHEMA_URL = new URL(
  '../../../packages/connectors-sdk/schema/order-mapping.schema.json',
  import.meta.url,
)

function loadJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'))
}

function loadFixture(name: string): OrderMappingPayload {
  return loadJson(new URL(name, SDK_FIXTURES_DIR)) as OrderMappingPayload
}

const ajv = new Ajv2020({ allErrors: true })
const validateAgainstSdkSchema = ajv.compile(loadJson(SDK_SCHEMA_URL) as object)

/** dueDate/businessProcessType/buyer.vatId : limitations v1 assumées (même
 * discipline que OrderMapperTest.php::expectedPayload — non deviné plutôt
 * que faux, cf. docblock order-mapper.ts). */
function expectedPayload(fixture: OrderMappingPayload): unknown {
  const clone = structuredClone(fixture) as unknown as Record<string, unknown>
  clone.dueDate = undefined
  clone.businessProcessType = undefined
  ;(clone.buyer as Record<string, unknown>).vatId = undefined
  return JSON.parse(JSON.stringify(clone))
}

function sellerConfigFromFixture(fixture: OrderMappingPayload): SellerConfig {
  return {
    name: fixture.seller.name,
    // Les 3 fixtures sdk rejouées ici portent toutes un seller.siren.
    siren: fixture.seller.siren!,
    vatId: fixture.seller.vatId,
    address: {
      streetName: fixture.seller.address.streetName,
      city: fixture.seller.address.city,
      postalCode: fixture.seller.address.postalCode,
      countryCode: fixture.seller.address.countryCode,
    },
  }
}

function taxLinesForRatePercent(ratePercent: string): ShopifyTaxLine[] {
  const rate = Number.parseFloat(ratePercent)
  return rate > 0 ? [{ rate: rate / 100 }] : []
}

function shopifyOrderFromFixture(
  fixture: OrderMappingPayload,
  opts: {
    billingCompany?: string
    billingFirstName?: string
    billingLastName?: string
    siret?: string
    lines?: OrderMappingPayload['lines']
  } = {},
): ShopifyOrder {
  return {
    id: 555,
    name: fixture.number,
    created_at: `${fixture.issueDate}T10:00:00+02:00`,
    currency: fixture.currency,
    billing_address: {
      company: opts.billingCompany ?? '',
      first_name: opts.billingFirstName ?? '',
      last_name: opts.billingLastName ?? '',
      address1: fixture.buyer.address.streetName,
      city: fixture.buyer.address.city,
      zip: fixture.buyer.address.postalCode,
      country_code: fixture.buyer.address.countryCode,
    },
    note_attributes: opts.siret
      ? [{ name: 'factelec_siret', value: opts.siret }]
      : [],
    line_items: (opts.lines ?? fixture.lines).map((line) => ({
      id: line.id,
      title: line.name,
      quantity: Number(line.quantity),
      price: line.unitPrice,
      tax_lines: taxLinesForRatePercent(line.vatRate),
    })),
    shipping_lines: [],
  }
}

describe('mapOrder — rejoue les fixtures sdk (contrat partagé PrestaShop/WooCommerce/Shopify)', () => {
  it("mappe b2b-siren.json à l'identique (hors limitations v1)", () => {
    const fixture = loadFixture('b2b-siren.json')
    const order = shopifyOrderFromFixture(fixture, {
      billingCompany: fixture.buyer.name,
      siret: '42195913500017',
    })
    const payload = mapOrder(order, sellerConfigFromFixture(fixture))
    expect(payload).toEqual(expectedPayload(fixture))
    expect(
      validateAgainstSdkSchema(payload),
      JSON.stringify(validateAgainstSdkSchema.errors),
    ).toBe(true)
  })

  it('mappe b2c-sans-siren.json sans siren ni vatId acheteur', () => {
    const fixture = loadFixture('b2c-sans-siren.json')
    const [firstName, lastName] = fixture.buyer.name.split(' ')
    const order = shopifyOrderFromFixture(fixture, {
      billingFirstName: firstName,
      billingLastName: lastName,
    })
    const payload = mapOrder(order, sellerConfigFromFixture(fixture))
    expect(payload).toEqual(expectedPayload(fixture))
    expect('siren' in payload.buyer).toBe(false)
    expect('vatId' in payload.buyer).toBe(false)
    expect(validateAgainstSdkSchema(payload)).toBe(true)
  })

  it('mappe multi-taux-tva.json en préservant le taux RÉEL de chaque ligne (jamais sommé)', () => {
    const fixture = loadFixture('multi-taux-tva.json')
    const order = shopifyOrderFromFixture(fixture, {
      billingCompany: fixture.buyer.name,
      siret: '42195913500017',
    })
    const payload = mapOrder(order, sellerConfigFromFixture(fixture))
    expect(payload).toEqual(expectedPayload(fixture))
    expect(payload.lines).toHaveLength(3)
    expect(payload.lines.map((l) => l.vatRate)).toEqual([
      '20.00',
      '5.50',
      '2.10',
    ])
    expect(validateAgainstSdkSchema(payload)).toBe(true)
  })

  it('rejette (ajv) un payload structurellement invalide témoin — le schéma réel distingue bien valide/invalide', () => {
    expect(validateAgainstSdkSchema({ number: 'X', lines: [] })).toBe(false)
    const missingBuyer = (validateAgainstSdkSchema.errors ?? []).some(
      (e: ErrorObject) =>
        e.keyword === 'required' &&
        (e.params as { missingProperty?: string }).missingProperty !==
          undefined,
    )
    expect(missingBuyer).toBe(true)
  })
})

const MINIMAL_SELLER: SellerConfig = {
  name: 'Ma Boutique',
  siren: '552100554',
  address: { countryCode: 'FR' },
}

function minimalOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 1,
    name: '#1001',
    created_at: '2026-07-24T10:00:00+02:00',
    currency: 'EUR',
    billing_address: {
      first_name: 'Camille',
      last_name: 'Durand',
      country_code: 'FR',
    },
    note_attributes: [],
    line_items: [
      {
        id: 1,
        title: 'Article',
        quantity: 1,
        price: '10.00',
        tax_lines: [{ rate: 0.2 }],
      },
    ],
    shipping_lines: [],
    ...overrides,
  }
}

describe('mapOrder — règles spécifiques (design §3)', () => {
  it('rejette une commande sans created_at exploitable (OrderMappingError)', () => {
    expect(() =>
      mapOrder(minimalOrder({ created_at: '' }), MINIMAL_SELLER),
    ).toThrow(OrderMappingError)
    expect(() =>
      mapOrder(minimalOrder({ created_at: 'pas-une-date' }), MINIMAL_SELLER),
    ).toThrow(/date de création/)
  })

  it('rejette une commande sans billing_address (OrderMappingError)', () => {
    expect(() =>
      mapOrder(minimalOrder({ billing_address: null }), MINIMAL_SELLER),
    ).toThrow(/adresse de facturation/)
  })

  it('rejette une commande sans nom acheteur exploitable (ni société ni prénom/nom)', () => {
    const order = minimalOrder({
      billing_address: { country_code: 'FR' },
    })
    expect(() => mapOrder(order, MINIMAL_SELLER)).toThrow(/nom acheteur/)
  })

  it('rejette une ligne avec PLUSIEURS tax_lines — ne somme JAMAIS les taux (design §3)', () => {
    const order = minimalOrder({
      line_items: [
        {
          id: 1,
          title: 'Article multi-juridiction',
          quantity: 1,
          price: '10.00',
          tax_lines: [{ rate: 0.06 }, { rate: 0.02 }],
        },
      ],
    })
    expect(() => mapOrder(order, MINIMAL_SELLER)).toThrow(OrderMappingError)
    expect(() => mapOrder(order, MINIMAL_SELLER)).toThrow(/composite/)
  })

  it('rejette une ligne avec tax_lines[0].rate === null (non exprimable en pourcentage)', () => {
    const order = minimalOrder({
      line_items: [
        {
          id: 1,
          title: 'Article',
          quantity: 1,
          price: '10.00',
          tax_lines: [{ rate: null }],
        },
      ],
    })
    expect(() => mapOrder(order, MINIMAL_SELLER)).toThrow(
      /non exprimable en pourcentage/,
    )
  })

  it('applique la même règle multi-tax_lines aux frais de port', () => {
    const order = minimalOrder({
      shipping_lines: [
        {
          id: 999,
          title: 'Livraison',
          price: '4.90',
          tax_lines: [{ rate: 0.1 }, { rate: 0.1 }],
        },
      ],
    })
    expect(() => mapOrder(order, MINIMAL_SELLER)).toThrow(/frais de port/)
  })

  it('une ligne sans tax_lines (0 %) est mappée en catégorie Z, jamais E', () => {
    const order = minimalOrder({
      line_items: [
        {
          id: 1,
          title: 'Produit à taux zéro',
          quantity: 1,
          price: '10.00',
          tax_lines: [],
        },
      ],
    })
    const payload = mapOrder(order, MINIMAL_SELLER)
    expect(payload.lines[0]).toMatchObject({
      vatCategory: 'Z',
      vatRate: '0.00',
    })
    expect(validateAgainstSdkSchema(payload)).toBe(true)
  })

  it('siren acheteur absent si le SIRET fait moins de 14 chiffres (traité comme B2C, jamais une erreur)', () => {
    const order = minimalOrder({
      note_attributes: [{ name: 'factelec_siret', value: '1234567890123' }],
    })
    const payload = mapOrder(order, MINIMAL_SELLER)
    expect('siren' in payload.buyer).toBe(false)
  })

  it('siren acheteur absent si note_attributes ne porte pas la clé factelec_siret', () => {
    const order = minimalOrder({
      note_attributes: [{ name: 'autre_champ', value: '42195913500017' }],
    })
    const payload = mapOrder(order, MINIMAL_SELLER)
    expect('siren' in payload.buyer).toBe(false)
  })

  it('mappe une ligne de port dédiée UNIQUEMENT si le montant est non nul', () => {
    const order = minimalOrder({
      shipping_lines: [
        {
          id: 999,
          title: 'Livraison standard',
          price: '4.90',
          tax_lines: [{ rate: 0.2 }],
        },
        { id: 998, title: 'Retrait magasin', price: '0.00', tax_lines: [] },
      ],
    })
    const payload = mapOrder(order, MINIMAL_SELLER)
    expect(payload.lines).toHaveLength(2)
    const shippingLine = payload.lines[1]
    expect(shippingLine).toMatchObject({
      id: '999',
      name: 'Livraison standard',
      quantity: '1',
      unitPrice: '4.90',
      vatCategory: 'S',
      vatRate: '20.00',
    })
  })

  it('rejette un prix Shopify non numérique exploitable', () => {
    const order = minimalOrder({
      line_items: [
        {
          id: 1,
          title: 'Article',
          quantity: 1,
          price: 'not-a-number',
          tax_lines: [],
        },
      ],
    })
    expect(() => mapOrder(order, MINIMAL_SELLER)).toThrow(/non numérique/)
  })

  it('utilise order_number puis id comme repli si name est absent', () => {
    const byOrderNumber = mapOrder(
      minimalOrder({ name: null, order_number: 4242 }),
      MINIMAL_SELLER,
    )
    expect(byOrderNumber.number).toBe('4242')

    const byId = mapOrder(
      minimalOrder({ name: null, order_number: null }),
      MINIMAL_SELLER,
    )
    expect(byId.number).toBe('1')
  })
})

describe('formatDecimal4', () => {
  it("préserve la précision réelle jusqu'à 4 décimales (régression fiscale portée de PHP)", () => {
    expect(formatDecimal4(19.995)).toBe('19.995')
    expect(formatDecimal4(12.3456)).toBe('12.3456')
  })

  it('formate une valeur "ronde" en 2 décimales (compatibilité fixtures sdk)', () => {
    expect(formatDecimal4(20)).toBe('20.00')
    expect(formatDecimal4(0)).toBe('0.00')
  })

  it('arrondit au-delà de 4 décimales sans dérive flottante', () => {
    // 0.145 * 100 = 14.499999999999998 en arithmétique flottante naïve.
    expect(formatDecimal4(0.145 * 100)).toBe('14.50')
  })

  it('respecte le pattern decimal4 du schéma sdk (regex ^\\d+(\\.\\d{1,4})?$)', () => {
    for (const value of [0, 20, 19.995, 12.3456, 8.855]) {
      expect(formatDecimal4(value)).toMatch(/^\d+(\.\d{1,4})?$/)
    }
  })
})
