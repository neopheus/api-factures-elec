import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildStatusReport, formatStatusReport } from '../src/cli-status.js'
import { FactelecClient } from '../src/factelec-client.js'
import { LinkStore } from '../src/link-store.js'

describe('buildStatusReport', () => {
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

  it('sans invoiceId (pending_retry) : ne fait AUCUN appel réseau, remote absent', async () => {
    store.recordPendingRetry('order-1', 'échec')
    const rows = await buildStatusReport(store.listAll(), client)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.remote).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('avec invoiceId : interroge GET /invoices/:id et rapporte status+lifecycleStatus', async () => {
    store.recordSubmitted('order-2', 'inv-2')
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'generated', lifecycleStatus: '203' }),
        { status: 200 },
      ),
    )
    const rows = await buildStatusReport(store.listAll(), client)
    expect(rows[0]?.remote).toEqual({
      ok: true,
      status: 'generated',
      lifecycleStatus: '203',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.factelec.example.com/invoices/inv-2')
  })

  it("erreur Factelec sur une liaison -> remote.ok=false, n'interrompt pas les autres lignes", async () => {
    store.recordSubmitted('order-3', 'inv-3')
    store.recordSubmitted('order-4', 'inv-4')
    // Réponse déterminée par l'URL appelée (pas par l'ORDRE d'appel — l'ordre
    // de store.listAll() sur des created_at quasi-identiques n'est pas garanti).
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/invoices/inv-4')) {
        return new Response(
          JSON.stringify({ type: 'urn:factelec:problem:not-found' }),
          { status: 404 },
        )
      }
      return new Response(
        JSON.stringify({ status: 'generated', lifecycleStatus: '203' }),
        { status: 200 },
      )
    })

    const rows = await buildStatusReport(store.listAll(), client)
    const failed = rows.find((r) => r.link.orderId === 'order-4')
    const succeeded = rows.find((r) => r.link.orderId === 'order-3')
    expect(failed?.remote?.ok).toBe(false)
    expect(succeeded?.remote).toEqual({
      ok: true,
      status: 'generated',
      lifecycleStatus: '203',
    })
  })

  it('corps de réponse sans status/lifecycleStatus exploitables -> "inconnu"', async () => {
    store.recordSubmitted('order-5', 'inv-5')
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    const rows = await buildStatusReport(store.listAll(), client)
    expect(rows[0]?.remote).toEqual({
      ok: true,
      status: 'inconnu',
      lifecycleStatus: 'inconnu',
    })
  })

  it("rapporte plusieurs liaisons dans l'ordre fourni", async () => {
    store.recordPendingRetry('order-a', 'échec')
    store.recordPendingRetry('order-b', 'échec')
    const rows = await buildStatusReport(store.listAll(), client)
    expect(rows).toHaveLength(2)
  })

  it('liste vide -> rapport vide', async () => {
    const rows = await buildStatusReport([], client)
    expect(rows).toEqual([])
  })
})

describe('formatStatusReport', () => {
  it('message dédié quand aucune liaison', () => {
    expect(formatStatusReport([])).toBe(
      'Aucune liaison commande/facture enregistrée.',
    )
  })

  it('formate une ligne pending_retry sans statut Factelec (remote absent)', () => {
    const output = formatStatusReport([
      {
        link: {
          orderId: '555',
          webhookIds: ['wh-1'],
          invoiceId: null,
          status: 'pending_retry',
          lastError: 'fetch failed',
          attempts: 2,
          orderPayload: null,
          createdAt: '2026-07-24T10:00:00.000Z',
          updatedAt: '2026-07-24T10:05:00.000Z',
        },
      },
    ])
    expect(output).toContain('555')
    expect(output).toContain('pending_retry')
    expect(output).toContain('\t-\t') // invoice_id absent
    expect(output).toMatch(/\t2\t/) // tentatives
  })

  it('formate une ligne submitted avec statut Factelec résolu', () => {
    const output = formatStatusReport([
      {
        link: {
          orderId: '556',
          webhookIds: [],
          invoiceId: 'inv-556',
          status: 'submitted',
          lastError: null,
          attempts: 1,
          orderPayload: null,
          createdAt: '2026-07-24T10:00:00.000Z',
          updatedAt: '2026-07-24T10:00:00.000Z',
        },
        remote: { ok: true, status: 'generated', lifecycleStatus: '203' },
      },
    ])
    expect(output).toContain('generated/203')
  })

  it("formate une ligne dont l'appel Factelec a échoué, sans fuite de détail structuré", () => {
    const output = formatStatusReport([
      {
        link: {
          orderId: '557',
          webhookIds: [],
          invoiceId: 'inv-557',
          status: 'submitted',
          lastError: null,
          attempts: 1,
          orderPayload: null,
          createdAt: '2026-07-24T10:00:00.000Z',
          updatedAt: '2026-07-24T10:00:00.000Z',
        },
        remote: { ok: false, reason: '[404] Introuvable' },
      },
    ])
    expect(output).toContain('injoignable ([404] Introuvable)')
  })

  it('inclut un en-tête de colonnes', () => {
    const output = formatStatusReport([
      {
        link: {
          orderId: '558',
          webhookIds: [],
          invoiceId: null,
          status: 'pending_retry',
          lastError: 'x',
          attempts: 1,
          orderPayload: null,
          createdAt: '2026-07-24T10:00:00.000Z',
          updatedAt: '2026-07-24T10:00:00.000Z',
        },
      },
    ])
    expect(output.split('\n')[0]).toBe(
      'order_id\tstatut\tinvoice_id\ttentatives\tmaj\tstatut_factelec',
    )
  })
})
