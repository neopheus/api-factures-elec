import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SellerConfig } from '../src/config.js'
import { FactelecClient } from '../src/factelec-client.js'
import { LinkStore } from '../src/link-store.js'
import {
  type RetrySchedulerDeps,
  runRetrySweep,
  startRetryScheduler,
} from '../src/retry-scheduler.js'

const SELLER: SellerConfig = {
  name: 'Ma Boutique',
  siren: '552100554',
  address: { countryCode: 'FR' },
}

const INTERVAL_MS = 300_000

const VALID_ORDER = {
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
}

describe('runRetrySweep', () => {
  let store: LinkStore
  let fetchMock: ReturnType<typeof vi.fn>
  let client: FactelecClient
  let deps: RetrySchedulerDeps

  beforeEach(() => {
    store = new LinkStore(':memory:')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    client = new FactelecClient(
      'https://api.factelec.example.com',
      'a'.repeat(20),
    )
    deps = { store, client, seller: SELLER, intervalMs: INTERVAL_MS }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    store.close()
  })

  function pendingSince(orderId: string, msAgo: number, attempts = 1): number {
    store.recordPendingRetry(orderId, 'échec initial', undefined, VALID_ORDER)
    // attempts=1 après le recordPendingRetry ci-dessus ; force le compteur et
    // la date de mise à jour pour contrôler précisément le scénario testé.
    // biome-ignore lint/suspicious/noExplicitAny: accès direct à la table pour piloter updated_at/attempts dans le test.
    const db = (store as any).db
    const updatedAt = new Date(Date.now() - msAgo).toISOString()
    db.prepare(
      'UPDATE invoice_link SET attempts = ?, updated_at = ? WHERE order_id = ?',
    ).run(attempts, updatedAt, orderId)
    return Date.now()
  }

  it('ignore une liaison pending_retry pas encore due (backoff)', async () => {
    pendingSince('order-1', 1_000, 1) // mise à jour il y a 1s, attempts=1 -> due après 1x intervalMs.
    await runRetrySweep(deps, Date.now())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.findByOrderId('order-1')?.status).toBe('pending_retry')
  })

  it('retente une liaison due et enregistre submitted en cas de succès', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-retry' }), { status: 201 }),
    )
    pendingSince('order-2', INTERVAL_MS + 1_000, 1)

    await runRetrySweep(deps, Date.now())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const link = store.findByOrderId('order-2')
    expect(link?.status).toBe('submitted')
    expect(link?.invoiceId).toBe('inv-retry')
    expect(link?.attempts).toBe(2)
  })

  it('reste pending_retry et incrémente attempts en cas de nouvel échec', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    pendingSince('order-3', INTERVAL_MS + 1_000, 1)

    await runRetrySweep(deps, Date.now())

    const link = store.findByOrderId('order-3')
    expect(link?.status).toBe('pending_retry')
    expect(link?.attempts).toBe(2)
  })

  it('applique le backoff : attempts=3 exige 4x intervalMs, pas 1x', async () => {
    pendingSince('order-4', INTERVAL_MS * 2, 3) // 2x intervalMs écoulé, il en faudrait 4x (2^(3-1)).
    await runRetrySweep(deps, Date.now())
    expect(fetchMock).not.toHaveBeenCalled()

    // Mais 5x intervalMs écoulé (>= 4x requis) déclenche bien la reprise.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-x' }), { status: 201 }),
    )
    pendingSince('order-5', INTERVAL_MS * 5, 3)
    await runRetrySweep(deps, Date.now())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('abandonne SANS appel réseau quand attempts atteint maxAttempts (défaut 10)', async () => {
    pendingSince('order-6', INTERVAL_MS * 100, 10)
    await runRetrySweep(deps, Date.now())

    expect(fetchMock).not.toHaveBeenCalled()
    const link = store.findByOrderId('order-6')
    expect(link?.status).toBe('abandoned')
    expect(link?.lastError).toMatch(/plafond/i)
  })

  it('respecte un maxAttempts personnalisé', async () => {
    pendingSince('order-7', INTERVAL_MS * 100, 3)
    await runRetrySweep({ ...deps, maxAttempts: 3 }, Date.now())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.findByOrderId('order-7')?.status).toBe('abandoned')
  })

  it('ne retente jamais une liaison déjà submitted ou abandoned (listPendingRetries filtre par statut)', async () => {
    store.recordSubmitted('order-8', 'inv-8')
    store.recordPendingRetry('order-9', 'échec', undefined, VALID_ORDER)
    store.markAbandoned('order-9', 'abandon test')

    await runRetrySweep(deps, Date.now())

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('balaie plusieurs liaisons dues indépendamment', async () => {
    // Une NOUVELLE Response par appel (un corps de réponse n'est lisible
    // qu'une fois — réutiliser la même instance casserait le 2e appel).
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: 'inv-multi' }), { status: 201 }),
    )
    pendingSince('order-10', INTERVAL_MS + 1, 1)
    pendingSince('order-11', INTERVAL_MS + 1, 1)

    await runRetrySweep(deps, Date.now())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.findByOrderId('order-10')?.status).toBe('submitted')
    expect(store.findByOrderId('order-11')?.status).toBe('submitted')
  })
})

describe('startRetryScheduler', () => {
  let store: LinkStore
  let fetchMock: ReturnType<typeof vi.fn>
  let client: FactelecClient

  beforeEach(() => {
    vi.useFakeTimers()
    store = new LinkStore(':memory:')
    fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'inv' }), { status: 201 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    client = new FactelecClient(
      'https://api.factelec.example.com',
      'a'.repeat(20),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    store.close()
  })

  it('balaie périodiquement toutes les intervalMs', async () => {
    store.recordPendingRetry('order-x', 'échec', undefined, VALID_ORDER)
    const scheduler = startRetryScheduler({
      store,
      client,
      seller: SELLER,
      intervalMs: 1_000,
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    scheduler.stop()
  })

  it('stop() arrête le balayage périodique', async () => {
    store.recordPendingRetry('order-y', 'échec', undefined, VALID_ORDER)
    const scheduler = startRetryScheduler({
      store,
      client,
      seller: SELLER,
      intervalMs: 1_000,
    })
    scheduler.stop()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
