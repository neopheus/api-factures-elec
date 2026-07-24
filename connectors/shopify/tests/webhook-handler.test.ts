import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SellerConfig } from '../src/config.js'
import { FactelecClient } from '../src/factelec-client.js'
import { LinkStore } from '../src/link-store.js'
import { createWebhookHandler } from '../src/webhook-handler.js'

const SELLER: SellerConfig = {
  name: 'Ma Boutique',
  siren: '552100554',
  address: { countryCode: 'FR' },
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
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

describe('createWebhookHandler', () => {
  let store: LinkStore
  let fetchMock: ReturnType<typeof vi.fn>
  let client: FactelecClient

  beforeEach(() => {
    store = new LinkStore(':memory:')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    client = new FactelecClient(
      'https://api.factelec.example.com',
      'a'.repeat(20),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    store.close()
  })

  it('mappe, soumet et enregistre submitted en cas de succès', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-123' }), { status: 201 }),
    )
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(order(), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-1',
    })

    const link = store.findByOrderId('555')
    expect(link?.status).toBe('submitted')
    expect(link?.invoiceId).toBe('inv-123')
    expect(link?.webhookIds).toEqual(['wh-1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('capture une erreur de MAPPING (pas seulement réseau/API) et enregistre pending_retry — acquis critique it.1', async () => {
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    // billing_address absent -> OrderMappingError, jamais une exception réseau.
    await handler(order({ billing_address: null }), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-2',
    })

    const link = store.findByOrderId('555')
    expect(link?.status).toBe('pending_retry')
    expect(link?.lastError).toMatch(/adresse de facturation/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('capture une panne RÉSEAU (fetch rejette, jamais FactelecApiError) et enregistre pending_retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(order(), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-3',
    })

    const link = store.findByOrderId('555')
    expect(link?.status).toBe('pending_retry')
    expect(link?.lastError).toBeTruthy()
  })

  it('capture une erreur API typée (ex. 422) et enregistre pending_retry sans fuite de clé', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'urn:factelec:problem:validation-error',
          title: 'Payload invalide',
        }),
        { status: 422 },
      ),
    )
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(order(), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-4',
    })

    const link = store.findByOrderId('555')
    expect(link?.status).toBe('pending_retry')
    expect(link?.lastError).toContain('Payload invalide')
  })

  it('persiste order_payload au premier échec — nécessaire au retry-scheduler', async () => {
    const handler = createWebhookHandler({ store, client, seller: SELLER })
    const rawOrder = order({ billing_address: null })

    await handler(rawOrder, {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-5',
    })

    const link = store.findByOrderId('555')
    expect(link?.orderPayload).toEqual(rawOrder)
  })

  it("dédup order_id : une commande déjà submitted n'est JAMAIS re-mappée ni re-soumise", async () => {
    store.recordSubmitted('555', 'inv-existing')
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(order(), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-6',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.findByOrderId('555')?.invoiceId).toBe('inv-existing')
  })

  it("dédup order_id : une commande déjà pending_retry n'est pas re-tentée par le webhook (le retry-scheduler s'en charge)", async () => {
    store.recordPendingRetry('555', 'échec précédent')
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(order(), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-7',
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignore silencieusement un order sans id exploitable (défensif)', async () => {
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(
      {},
      {
        topic: 'orders/paid',
        shopDomain: 'x.myshopify.com',
        webhookId: 'wh-8',
      },
    )
    await handler(null, {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-9',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.listAll()).toHaveLength(0)
  })

  it('accepte un id numérique ET le normalise en chaîne pour la clé de liaison', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-999' }), { status: 201 }),
    )
    const handler = createWebhookHandler({ store, client, seller: SELLER })

    await handler(order({ id: 777 }), {
      topic: 'orders/paid',
      shopDomain: 'x.myshopify.com',
      webhookId: 'wh-10',
    })

    expect(store.findByOrderId('777')?.status).toBe('submitted')
  })
})
