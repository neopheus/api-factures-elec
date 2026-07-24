import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FactelecApiError, FactelecClient } from '../src/factelec-client.js'

const BASE_URL = 'https://api.factelec.example.com'
const API_KEY = 'une-cle-api-de-test-secrete'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('FactelecClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('testConnection', () => {
    it('renvoie ok=true sur 200', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }))
      const client = new FactelecClient(BASE_URL, API_KEY)
      const result = await client.testConnection()
      expect(result).toEqual({ ok: true })
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${BASE_URL}/invoices?limit=1`)
      expect(init.method).toBe('GET')
      expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    })

    it('renvoie reason=unauthorized sur 401', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { type: 'urn:factelec:problem:unauthorized' }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      const result = await client.testConnection()
      expect(result).toEqual({ ok: false, reason: 'unauthorized' })
    })

    it('renvoie reason=network-error sur un statut inattendu (500)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(500, {}))
      const client = new FactelecClient(BASE_URL, API_KEY)
      const result = await client.testConnection()
      expect(result).toEqual({ ok: false, reason: 'network-error' })
    })

    it('renvoie reason=network-error sur une panne réseau (fetch rejette)', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))
      const client = new FactelecClient(BASE_URL, API_KEY)
      const result = await client.testConnection()
      expect(result).toEqual({ ok: false, reason: 'network-error' })
    })

    it('ne lève jamais — toute issue est un résultat typé', async () => {
      fetchMock.mockRejectedValue(new Error('boom'))
      const client = new FactelecClient(BASE_URL, API_KEY)
      await expect(client.testConnection()).resolves.not.toThrow()
    })
  })

  describe('submitInvoice', () => {
    const payload = {
      number: 'F-2026-0001',
      issueDate: '2026-07-24',
      typeCode: '380' as const,
      currency: 'EUR',
      seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
      buyer: { name: 'Client', address: { countryCode: 'FR' } },
      lines: [],
    }

    it('renvoie invoiceId sur 201', async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, { id: 'inv-123' }))
      const client = new FactelecClient(BASE_URL, API_KEY)
      const result = await client.submitInvoice(payload)
      expect(result).toEqual({ invoiceId: 'inv-123' })
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${BASE_URL}/invoices`)
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(init.body)).toEqual(payload)
    })

    it('lève FactelecApiError sur 201 sans id exploitable', async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, {}))
      const client = new FactelecClient(BASE_URL, API_KEY)
      await expect(client.submitInvoice(payload)).rejects.toBeInstanceOf(
        FactelecApiError,
      )
    })

    it('lève FactelecApiError typée (problem-details) sur 422', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(422, {
          type: 'urn:factelec:problem:validation-error',
          title: 'Payload invalide',
          detail: 'lines[0].vatRate manquant',
        }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      try {
        await client.submitInvoice(payload)
        expect.unreachable('devait lever')
      } catch (error) {
        expect(error).toBeInstanceOf(FactelecApiError)
        const apiError = error as FactelecApiError
        expect(apiError.httpStatus).toBe(422)
        expect(apiError.problemType).toBe(
          'urn:factelec:problem:validation-error',
        )
        expect(apiError.problemDetail).toBe('lines[0].vatRate manquant')
      }
    })

    it('lève FactelecApiError sur 402 (subscription-required)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(402, {
          type: 'urn:factelec:problem:subscription-required',
          title: 'Abonnement requis',
        }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      await expect(client.submitInvoice(payload)).rejects.toMatchObject({
        httpStatus: 402,
      })
    })

    it('tolère un corps non-JSON (proxy en erreur) sans planter', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      try {
        await client.submitInvoice(payload)
        expect.unreachable('devait lever')
      } catch (error) {
        expect(error).toBeInstanceOf(FactelecApiError)
        expect((error as FactelecApiError).httpStatus).toBe(502)
        expect((error as FactelecApiError).problemType).toBe(
          'urn:factelec:problem:unknown',
        )
      }
    })

    it('tolère un corps de réponse vide', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 500 }))
      const client = new FactelecClient(BASE_URL, API_KEY)
      await expect(client.submitInvoice(payload)).rejects.toMatchObject({
        httpStatus: 500,
        problemType: 'urn:factelec:problem:unknown',
      })
    })

    it("ne fait JAMAIS fuiter la clé API dans le message d'erreur", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, {
          type: 'urn:factelec:problem:tenant-suspended',
          title: 'Compte suspendu',
        }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      try {
        await client.submitInvoice(payload)
        expect.unreachable('devait lever')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).not.toContain(API_KEY)
      }
    })
  })

  describe('getInvoiceStatus', () => {
    it('renvoie le corps décodé sur 200', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { lifecycleStatus: 'accepted' }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      const result = await client.getInvoiceStatus('inv-1')
      expect(result).toEqual({ lifecycleStatus: 'accepted' })
      const [url] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${BASE_URL}/invoices/inv-1`)
    })

    it("encode l'identifiant dans l'URL", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}))
      const client = new FactelecClient(BASE_URL, API_KEY)
      await client.getInvoiceStatus('inv/with space')
      const [url] = fetchMock.mock.calls[0]!
      expect(url).toBe(
        `${BASE_URL}/invoices/${encodeURIComponent('inv/with space')}`,
      )
    })

    it('lève FactelecApiError sur 404', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, {
          type: 'urn:factelec:problem:not-found',
          title: 'Introuvable',
        }),
      )
      const client = new FactelecClient(BASE_URL, API_KEY)
      await expect(client.getInvoiceStatus('inconnue')).rejects.toBeInstanceOf(
        FactelecApiError,
      )
    })
  })
})
