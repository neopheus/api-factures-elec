import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { ensureBillingCatalog } from '../../scripts/billing-bootstrap.js'

// Fabrique un Stripe mocké minimal : seules les méthodes consommées par
// ensureBillingCatalog sont implémentées — fonction pure testée en isolation
// totale du réseau, aucun besoin du reste de la surface du SDK.
function makeStripe(overrides: {
  pricesList?: ReturnType<typeof vi.fn>
  pricesCreate?: ReturnType<typeof vi.fn>
  metersList?: ReturnType<typeof vi.fn>
  metersCreate?: ReturnType<typeof vi.fn>
  productsSearch?: ReturnType<typeof vi.fn>
  productsCreate?: ReturnType<typeof vi.fn>
}): Stripe {
  return {
    prices: {
      list: overrides.pricesList ?? vi.fn().mockResolvedValue({ data: [] }),
      create: overrides.pricesCreate ?? vi.fn(),
    },
    billing: {
      meters: {
        list: overrides.metersList ?? vi.fn().mockResolvedValue({ data: [] }),
        create: overrides.metersCreate ?? vi.fn(),
      },
    },
    products: {
      search:
        overrides.productsSearch ?? vi.fn().mockResolvedValue({ data: [] }),
      create: overrides.productsCreate ?? vi.fn(),
    },
    // biome-ignore lint/suspicious/noExplicitAny: fixture de test — shape volontairement partielle du SDK Stripe
  } as any as Stripe
}

describe('ensureBillingCatalog', () => {
  it('catalogue absent : crée le meter, le product et les deux prices avec les shapes/montants exacts', async () => {
    const metersCreate = vi.fn().mockResolvedValue({ id: 'meter_new' })
    const productsCreate = vi.fn().mockResolvedValue({ id: 'prod_new' })
    const pricesCreate = vi
      .fn()
      .mockResolvedValueOnce({ id: 'price_base_new' })
      .mockResolvedValueOnce({ id: 'price_metered_new' })
    const stripe = makeStripe({ metersCreate, productsCreate, pricesCreate })

    const result = await ensureBillingCatalog(stripe)

    expect(metersCreate).toHaveBeenCalledExactlyOnceWith({
      display_name: 'Documents traités',
      event_name: 'documents_processed',
      default_aggregation: { formula: 'sum' },
      customer_mapping: {
        event_payload_key: 'stripe_customer_id',
        type: 'by_id',
      },
      value_settings: { event_payload_key: 'value' },
    })
    expect(productsCreate).toHaveBeenCalledExactlyOnceWith({
      name: 'Factelec',
      metadata: { factelec: 'base' },
    })
    expect(pricesCreate).toHaveBeenNthCalledWith(1, {
      product: 'prod_new',
      currency: 'eur',
      unit_amount: 2900,
      recurring: { interval: 'month' },
      lookup_key: 'factelec_base',
      tax_behavior: 'exclusive',
    })
    expect(pricesCreate).toHaveBeenNthCalledWith(2, {
      product: 'prod_new',
      currency: 'eur',
      recurring: {
        interval: 'month',
        usage_type: 'metered',
        meter: 'meter_new',
      },
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: 100, unit_amount: 0 },
        { up_to: 'inf', unit_amount: 20 },
      ],
      lookup_key: 'factelec_metered',
      tax_behavior: 'exclusive',
    })
    expect(result).toEqual({
      priceBase: 'price_base_new',
      priceMetered: 'price_metered_new',
    })
  })

  it('catalogue déjà complet (prices.list renvoie les deux lookup_keys) : aucune création, ids existants renvoyés', async () => {
    const pricesList = vi.fn().mockResolvedValue({
      data: [
        { id: 'price_base_existing', lookup_key: 'factelec_base' },
        { id: 'price_metered_existing', lookup_key: 'factelec_metered' },
      ],
    })
    const metersList = vi.fn()
    const metersCreate = vi.fn()
    const productsSearch = vi.fn()
    const productsCreate = vi.fn()
    const pricesCreate = vi.fn()
    const stripe = makeStripe({
      pricesList,
      metersList,
      metersCreate,
      productsSearch,
      productsCreate,
      pricesCreate,
    })

    const result = await ensureBillingCatalog(stripe)

    expect(pricesList).toHaveBeenCalledExactlyOnceWith({
      lookup_keys: ['factelec_base', 'factelec_metered'],
      limit: 10,
    })
    expect(metersList).not.toHaveBeenCalled()
    expect(metersCreate).not.toHaveBeenCalled()
    expect(productsSearch).not.toHaveBeenCalled()
    expect(productsCreate).not.toHaveBeenCalled()
    expect(pricesCreate).not.toHaveBeenCalled()
    expect(result).toEqual({
      priceBase: 'price_base_existing',
      priceMetered: 'price_metered_existing',
    })
  })

  it('catalogue partiel (base présent, métré absent) : ne crée que le prix manquant', async () => {
    const pricesList = vi.fn().mockResolvedValue({
      data: [{ id: 'price_base_existing', lookup_key: 'factelec_base' }],
    })
    const metersList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'meter_active',
          event_name: 'documents_processed',
          status: 'active',
        },
      ],
    })
    const metersCreate = vi.fn()
    const productsSearch = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'prod_existing' }] })
    const productsCreate = vi.fn()
    const pricesCreate = vi.fn().mockResolvedValue({ id: 'price_metered_new' })
    const stripe = makeStripe({
      pricesList,
      metersList,
      metersCreate,
      productsSearch,
      productsCreate,
      pricesCreate,
    })

    const result = await ensureBillingCatalog(stripe)

    expect(metersCreate).not.toHaveBeenCalled()
    expect(productsCreate).not.toHaveBeenCalled()
    expect(pricesCreate).toHaveBeenCalledExactlyOnceWith({
      product: 'prod_existing',
      currency: 'eur',
      recurring: {
        interval: 'month',
        usage_type: 'metered',
        meter: 'meter_active',
      },
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: 100, unit_amount: 0 },
        { up_to: 'inf', unit_amount: 20 },
      ],
      lookup_key: 'factelec_metered',
      tax_behavior: 'exclusive',
    })
    expect(result).toEqual({
      priceBase: 'price_base_existing',
      priceMetered: 'price_metered_new',
    })
  })

  it('meter déjà existant et actif : réutilisé, pas de meters.create', async () => {
    const metersList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'meter_existing',
          event_name: 'documents_processed',
          status: 'active',
        },
        // Meter inactif avec le même event_name : ne doit jamais être
        // retenu (un meter désactivé ne peut plus être rattaché à un prix).
        {
          id: 'meter_inactive',
          event_name: 'documents_processed',
          status: 'inactive',
        },
      ],
    })
    const metersCreate = vi.fn()
    const productsCreate = vi.fn().mockResolvedValue({ id: 'prod_new' })
    const pricesCreate = vi
      .fn()
      .mockResolvedValueOnce({ id: 'price_base_new' })
      .mockResolvedValueOnce({ id: 'price_metered_new' })
    const stripe = makeStripe({
      metersList,
      metersCreate,
      productsCreate,
      pricesCreate,
    })

    await ensureBillingCatalog(stripe)

    expect(metersCreate).not.toHaveBeenCalled()
    expect(pricesCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        recurring: expect.objectContaining({ meter: 'meter_existing' }),
      }),
    )
  })
})
