import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureWebhookSubscription,
  ShopifyAdminApiError,
  ShopifyAdminClient,
} from '../src/shopify-client.js'

const SHOP = 'ma-boutique.myshopify.com'
const TOKEN = 'shpat_test_token'
const ADDRESS = 'https://connector.example.com/webhooks/shopify'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ShopifyAdminClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listWebhooks envoie X-Shopify-Access-Token et mappe la réponse', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        webhooks: [{ id: 1, topic: 'orders/paid', address: ADDRESS }],
      }),
    )
    const client = new ShopifyAdminClient(SHOP, TOKEN)
    const result = await client.listWebhooks()
    expect(result).toEqual([
      { id: '1', topic: 'orders/paid', address: ADDRESS },
    ])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toMatch(
      new RegExp(`^https://${SHOP}/admin/api/\\d{4}-\\d{2}/webhooks\\.json$`),
    )
    expect(init.headers['X-Shopify-Access-Token']).toBe(TOKEN)
  })

  it('listWebhooks renvoie [] quand la réponse ne porte pas de webhooks', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    const client = new ShopifyAdminClient(SHOP, TOKEN)
    await expect(client.listWebhooks()).resolves.toEqual([])
  })

  it('lève ShopifyAdminApiError même si le corps de la réponse en erreur est illisible', async () => {
    const response = new Response('', { status: 500 })
    vi.spyOn(response, 'text').mockRejectedValue(
      new Error('body already consumed'),
    )
    fetchMock.mockResolvedValue(response)
    const client = new ShopifyAdminClient(SHOP, TOKEN)
    await expect(client.listWebhooks()).rejects.toBeInstanceOf(
      ShopifyAdminApiError,
    )
  })

  it('listWebhooks lève ShopifyAdminApiError sur statut non-ok', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { errors: 'Invalid API key' }),
    )
    const client = new ShopifyAdminClient(SHOP, TOKEN)
    await expect(client.listWebhooks()).rejects.toBeInstanceOf(
      ShopifyAdminApiError,
    )
  })

  it('createWebhook POST le topic/address et mappe la réponse créée', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        webhook: { id: 42, topic: 'orders/paid', address: ADDRESS },
      }),
    )
    const client = new ShopifyAdminClient(SHOP, TOKEN)
    const result = await client.createWebhook('orders/paid', ADDRESS)
    expect(result).toEqual({ id: '42', topic: 'orders/paid', address: ADDRESS })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      webhook: { topic: 'orders/paid', address: ADDRESS, format: 'json' },
    })
  })

  it('createWebhook lève ShopifyAdminApiError sur statut non-ok', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, { errors: { address: ['is invalid'] } }),
    )
    const client = new ShopifyAdminClient(SHOP, TOKEN)
    await expect(
      client.createWebhook('orders/paid', 'not-a-url'),
    ).rejects.toBeInstanceOf(ShopifyAdminApiError)
  })
})

describe('ensureWebhookSubscription', () => {
  it('ne crée rien si un abonnement (topic, address) identique existe déjà — idempotent', async () => {
    const listWebhooks = vi
      .fn()
      .mockResolvedValue([{ id: '1', topic: 'orders/paid', address: ADDRESS }])
    const createWebhook = vi.fn()
    const client = {
      listWebhooks,
      createWebhook,
    } as unknown as ShopifyAdminClient

    const result = await ensureWebhookSubscription(
      client,
      'orders/paid',
      ADDRESS,
    )

    expect(result).toEqual({
      created: false,
      subscription: { id: '1', topic: 'orders/paid', address: ADDRESS },
    })
    expect(createWebhook).not.toHaveBeenCalled()
  })

  it('crée un abonnement quand aucun ne correspond (topic, address)', async () => {
    const listWebhooks = vi.fn().mockResolvedValue([])
    const createWebhook = vi
      .fn()
      .mockResolvedValue({ id: '9', topic: 'orders/paid', address: ADDRESS })
    const client = {
      listWebhooks,
      createWebhook,
    } as unknown as ShopifyAdminClient

    const result = await ensureWebhookSubscription(
      client,
      'orders/paid',
      ADDRESS,
    )

    expect(result).toEqual({
      created: true,
      subscription: { id: '9', topic: 'orders/paid', address: ADDRESS },
    })
    expect(createWebhook).toHaveBeenCalledWith('orders/paid', ADDRESS)
  })

  it('crée si un abonnement existe pour un AUTRE topic à la même adresse', async () => {
    const listWebhooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', topic: 'orders/fulfilled', address: ADDRESS },
      ])
    const createWebhook = vi
      .fn()
      .mockResolvedValue({ id: '2', topic: 'orders/paid', address: ADDRESS })
    const client = {
      listWebhooks,
      createWebhook,
    } as unknown as ShopifyAdminClient

    const result = await ensureWebhookSubscription(
      client,
      'orders/paid',
      ADDRESS,
    )

    expect(result.created).toBe(true)
    expect(createWebhook).toHaveBeenCalledWith('orders/paid', ADDRESS)
  })

  it("propage l'erreur si listWebhooks échoue (main.ts logue et continue)", async () => {
    const listWebhooks = vi
      .fn()
      .mockRejectedValue(new ShopifyAdminApiError(500, 'boom'))
    const createWebhook = vi.fn()
    const client = {
      listWebhooks,
      createWebhook,
    } as unknown as ShopifyAdminClient

    await expect(
      ensureWebhookSubscription(client, 'orders/paid', ADDRESS),
    ).rejects.toBeInstanceOf(ShopifyAdminApiError)
    expect(createWebhook).not.toHaveBeenCalled()
  })
})
