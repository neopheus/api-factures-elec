import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { LinkStore } from '../src/link-store.js'
import {
  createServer,
  handleLinks,
  isLoopback,
  readRawBody,
  type ShopifyWebhookHandler,
} from '../src/server.js'

const SECRET = 'un-secret-partage-de-test-1234'

const BASE_ENV: Record<string, string> = {
  SHOPIFY_SHOP: 'ma-boutique.myshopify.com',
  SHOPIFY_ACCESS_TOKEN: 'a'.repeat(24),
  SHOPIFY_WEBHOOK_SECRET: SECRET,
  SHOPIFY_TOPIC: 'orders/paid',
  PUBLIC_WEBHOOK_URL: 'https://connector.example.com',
  FACTELEC_API_URL: 'https://api.factelec.example.com',
  FACTELEC_API_KEY: 'b'.repeat(16),
  SELLER_NAME: 'Vendeur',
  SELLER_SIREN: '123456789',
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64')
}

describe('isLoopback', () => {
  it('reconnaît les adresses loopback IPv4/IPv6', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejette une adresse externe ou absente', () => {
    expect(isLoopback('203.0.113.10')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })
})

describe('handleLinks (unitaire, sans TCP réel)', () => {
  function fakeRes() {
    return {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as import('node:http').ServerResponse
  }

  it('403 nu quand la connexion ne vient pas de loopback', () => {
    const store = new LinkStore(':memory:')
    const req = {
      socket: { remoteAddress: '203.0.113.10' },
    } as unknown as IncomingMessage
    const res = fakeRes()
    handleLinks(req, res, store)
    expect(res.writeHead).toHaveBeenCalledWith(403)
    expect(res.end).toHaveBeenCalledWith()
    store.close()
  })

  it('200 + JSON du store quand la connexion vient de loopback', () => {
    const store = new LinkStore(':memory:')
    store.recordSubmitted('order-x', 'inv-x')
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage
    const res = fakeRes()
    handleLinks(req, res, store)
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'application/json',
    })
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('order-x'))
    store.close()
  })
})

describe('readRawBody (unitaire, sans TCP réel)', () => {
  it('résout avec la concaténation des chunks reçus', async () => {
    const req = new EventEmitter() as unknown as IncomingMessage
    const promise = readRawBody(req)
    req.emit('data', Buffer.from('hello '))
    req.emit('data', Buffer.from('world'))
    req.emit('end')
    await expect(promise).resolves.toEqual(Buffer.from('hello world'))
  })

  it('rejette et détruit la requête au-delà de MAX_BODY_BYTES (garde mémoire)', async () => {
    const req = new EventEmitter() as unknown as IncomingMessage
    const destroy = vi.fn()
    ;(req as unknown as { destroy: typeof destroy }).destroy = destroy
    const promise = readRawBody(req)
    req.emit('data', Buffer.alloc(5 * 1024 * 1024 + 1, 1))
    await expect(promise).rejects.toThrow('payload too large')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('rejette sur erreur du flux', async () => {
    const req = new EventEmitter() as unknown as IncomingMessage
    const promise = readRawBody(req)
    req.emit('error', new Error('socket hang up'))
    await expect(promise).rejects.toThrow('socket hang up')
  })
})

describe('server HTTP (POST /webhooks/shopify, GET /links)', () => {
  let store: LinkStore
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let handler: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    store = new LinkStore(':memory:')
    handler = vi.fn()
    const config = loadConfig(BASE_ENV)
    server = createServer(config, store, {
      onWebhook: handler as unknown as ShopifyWebhookHandler,
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    )
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  })

  const orderBody = JSON.stringify({ id: 555, name: '#1001' })
  const validHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': sign(orderBody),
    'X-Shopify-Topic': 'orders/paid',
    'X-Shopify-Shop-Domain': 'ma-boutique.myshopify.com',
    'X-Shopify-Webhook-Id': 'wh-1',
  })

  it('200 + appelle le handler injecté sur une requête valide', async () => {
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: validHeaders(),
      body: orderBody,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(handler).toHaveBeenCalledTimes(1)
    const [order, meta] = handler.mock.calls[0]!
    expect(order).toEqual({ id: 555, name: '#1001' })
    expect(meta).toEqual({
      topic: 'orders/paid',
      shopDomain: 'ma-boutique.myshopify.com',
      webhookId: 'wh-1',
    })
  })

  it('401 nu sur signature HMAC invalide, handler jamais appelé', async () => {
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: { ...validHeaders(), 'X-Shopify-Hmac-Sha256': 'aW52YWxpZGU=' },
      body: orderBody,
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(handler).not.toHaveBeenCalled()
  })

  it('401 nu quand la signature est absente', async () => {
    const headers = validHeaders()
    delete headers['X-Shopify-Hmac-Sha256']
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers,
      body: orderBody,
    })
    expect(res.status).toBe(401)
  })

  it('200 nu (ignoré) sur topic inattendu, handler jamais appelé', async () => {
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: { ...validHeaders(), 'X-Shopify-Topic': 'orders/fulfilled' },
      body: orderBody,
    })
    expect(res.status).toBe(200)
    expect(handler).not.toHaveBeenCalled()
  })

  it('200 nu (ignoré) sur shop domain inattendu, handler jamais appelé', async () => {
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: {
        ...validHeaders(),
        'X-Shopify-Shop-Domain': 'autre-boutique.myshopify.com',
      },
      body: orderBody,
    })
    expect(res.status).toBe(200)
    expect(handler).not.toHaveBeenCalled()
  })

  it('idempotence : re-livraison du même X-Shopify-Webhook-Id court-circuite le handler', async () => {
    store.recordSubmitted('555', 'inv-555', 'wh-1')
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: validHeaders(),
      body: orderBody,
    })
    expect(res.status).toBe(200)
    expect(handler).not.toHaveBeenCalled()
  })

  it("200 nu si le corps n'est pas du JSON exploitable", async () => {
    const body = 'not-json'
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: { ...validHeaders(), 'X-Shopify-Hmac-Sha256': sign(body) },
      body,
    })
    expect(res.status).toBe(200)
    expect(handler).not.toHaveBeenCalled()
  })

  it('200 nu même si le handler injecté lève (aucun détail exposé, contrat Shopify)', async () => {
    handler.mockRejectedValue(new Error('mapping cassé'))
    const res = await fetch(`${baseUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: validHeaders(),
      body: orderBody,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('404 nu sur une route inconnue', async () => {
    const res = await fetch(`${baseUrl}/inconnue`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  it('404 nu sur GET /webhooks/shopify (mauvaise méthode)', async () => {
    const res = await fetch(`${baseUrl}/webhooks/shopify`)
    expect(res.status).toBe(404)
  })

  it('GET /links renvoie le contenu JSON du store depuis localhost', async () => {
    store.recordSubmitted('555', 'inv-555')
    const res = await fetch(`${baseUrl}/links`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as Array<{ orderId: string }>
    expect(body).toHaveLength(1)
    expect(body[0]?.orderId).toBe('555')
  })

  it('GET /links renvoie [] quand le store est vide', async () => {
    const res = await fetch(`${baseUrl}/links`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("utilise le handler no-op par défaut quand aucun n'est injecté", async () => {
    const defaultServer = createServer(loadConfig(BASE_ENV), store)
    await new Promise<void>((resolve) =>
      defaultServer.listen(0, '127.0.0.1', () => resolve()),
    )
    const address = defaultServer.address() as AddressInfo
    try {
      const res = await fetch(
        `http://127.0.0.1:${address.port}/webhooks/shopify`,
        {
          method: 'POST',
          headers: validHeaders(),
          body: orderBody,
        },
      )
      expect(res.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => defaultServer.close(() => resolve()))
    }
  })
})
