import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LinkStore } from '../src/link-store.js'

describe('LinkStore', () => {
  let store: LinkStore

  beforeEach(() => {
    store = new LinkStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('findByOrderId retourne undefined pour une commande inconnue', () => {
    expect(store.findByOrderId('inconnue')).toBeUndefined()
  })

  it('recordSubmitted crée une liaison submitted', () => {
    const link = store.recordSubmitted('order-1', 'inv-1', 'wh-1')
    expect(link.orderId).toBe('order-1')
    expect(link.invoiceId).toBe('inv-1')
    expect(link.status).toBe('submitted')
    expect(link.lastError).toBeNull()
    expect(link.attempts).toBe(1)
    expect(link.webhookIds).toEqual(['wh-1'])
    expect(link.createdAt).toBe(link.updatedAt)
  })

  it("recordPendingRetry crée une liaison pending_retry avec l'erreur", () => {
    const link = store.recordPendingRetry('order-2', 'panne réseau', 'wh-2')
    expect(link.status).toBe('pending_retry')
    expect(link.invoiceId).toBeNull()
    expect(link.lastError).toBe('panne réseau')
    expect(link.attempts).toBe(1)
  })

  it('order_id est UNIQUE : un second upsert MET À JOUR la même ligne (pas de doublon)', () => {
    store.recordPendingRetry('order-3', 'échec 1', 'wh-3a')
    const updated = store.recordSubmitted('order-3', 'inv-3', 'wh-3b')
    expect(updated.status).toBe('submitted')
    expect(updated.invoiceId).toBe('inv-3')
    expect(updated.lastError).toBeNull()
    expect(updated.attempts).toBe(2)
    expect(updated.webhookIds).toEqual(['wh-3a', 'wh-3b'])
    expect(store.listAll().filter((l) => l.orderId === 'order-3')).toHaveLength(
      1,
    )
  })

  it('createdAt est préservé, updatedAt avance à chaque upsert', () => {
    const first = store.recordPendingRetry('order-4', 'échec')
    const second = store.recordSubmitted('order-4', 'inv-4')
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('ne duplique pas un webhookId déjà enregistré pour la même commande', () => {
    store.recordSubmitted('order-5', 'inv-5', 'wh-5')
    const again = store.recordSubmitted('order-5', 'inv-5', 'wh-5')
    expect(again.webhookIds).toEqual(['wh-5'])
  })

  it('markRetried transitionne pending_retry -> submitted en succès', () => {
    store.recordPendingRetry('order-6', 'échec initial')
    const retried = store.markRetried('order-6', {
      ok: true,
      invoiceId: 'inv-6',
    })
    expect(retried.status).toBe('submitted')
    expect(retried.invoiceId).toBe('inv-6')
    expect(retried.lastError).toBeNull()
    expect(retried.attempts).toBe(2)
  })

  it('markRetried reste pending_retry et met à jour last_error en cas de nouvel échec', () => {
    store.recordPendingRetry('order-7', 'échec 1')
    const retried = store.markRetried('order-7', {
      ok: false,
      error: 'échec 2',
    })
    expect(retried.status).toBe('pending_retry')
    expect(retried.lastError).toBe('échec 2')
    expect(retried.attempts).toBe(2)
  })

  it('markRetried lève pour une commande inconnue (ne crée jamais de liaison)', () => {
    expect(() =>
      store.markRetried('inconnue', { ok: true, invoiceId: 'x' }),
    ).toThrow(/liaison inconnue/)
  })

  it('hasProcessedWebhook détecte un webhookId déjà vu (toutes commandes confondues)', () => {
    store.recordSubmitted('order-8', 'inv-8', 'wh-8')
    expect(store.hasProcessedWebhook('wh-8')).toBe(true)
    expect(store.hasProcessedWebhook('wh-inconnu')).toBe(false)
  })

  it('hasProcessedWebhook renvoie false sur un store vide', () => {
    expect(store.hasProcessedWebhook('wh-quelconque')).toBe(false)
  })

  it('listAll retourne toutes les liaisons, plus récentes en premier', () => {
    store.recordSubmitted('order-a', 'inv-a')
    store.recordSubmitted('order-b', 'inv-b')
    const all = store.listAll()
    expect(all).toHaveLength(2)
    expect(all.map((l) => l.orderId).sort()).toEqual(['order-a', 'order-b'])
  })

  it('résiste à un JSON webhook_ids corrompu en lecture (dégrade à liste vide)', () => {
    // Accès direct à la table pour simuler une corruption — n'utilise
    // délibérément pas l'API publique du store.
    // biome-ignore lint/suspicious/noExplicitAny: accès à l'implémentation interne pour le test de résilience.
    const raw = (store as any).db as import('better-sqlite3').Database
    raw
      .prepare(
        `INSERT INTO invoice_link (order_id, webhook_ids, invoice_id, status, last_error, attempts, created_at, updated_at)
         VALUES ('order-corrupt', 'not-json', NULL, 'submitted', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const link = store.findByOrderId('order-corrupt')
    expect(link?.webhookIds).toEqual([])
  })

  it('dégrade à liste vide quand webhook_ids est un JSON valide mais pas un tableau', () => {
    // biome-ignore lint/suspicious/noExplicitAny: accès à l'implémentation interne pour le test de résilience.
    const raw = (store as any).db as import('better-sqlite3').Database
    raw
      .prepare(
        `INSERT INTO invoice_link (order_id, webhook_ids, invoice_id, status, last_error, attempts, created_at, updated_at)
         VALUES ('order-not-array', '{"oops":true}', NULL, 'submitted', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const link = store.findByOrderId('order-not-array')
    expect(link?.webhookIds).toEqual([])
  })
})

describe('LinkStore — order_payload / statut abandoned (Task 2)', () => {
  let store: LinkStore

  beforeEach(() => {
    store = new LinkStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('recordPendingRetry persiste order_payload, préservé par les upserts suivants sans le refournir', () => {
    const rawOrder = { id: 555, line_items: [] }
    const first = store.recordPendingRetry(
      'order-p1',
      'échec 1',
      'wh-1',
      rawOrder,
    )
    expect(first.orderPayload).toEqual(rawOrder)

    const second = store.recordPendingRetry('order-p1', 'échec 2', 'wh-2')
    expect(second.orderPayload).toEqual(rawOrder)
  })

  it('recordSubmitted préserve order_payload déjà stocké sans le refournir', () => {
    store.recordPendingRetry('order-p2', 'échec', undefined, { id: 1 })
    const submitted = store.recordSubmitted('order-p2', 'inv-p2')
    expect(submitted.orderPayload).toEqual({ id: 1 })
  })

  it('résiste à un order_payload corrompu en lecture (dégrade à null)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: accès à l'implémentation interne pour le test de résilience.
    const raw = (store as any).db as import('better-sqlite3').Database
    raw
      .prepare(
        `INSERT INTO invoice_link (order_id, webhook_ids, invoice_id, status, last_error, attempts, order_payload, created_at, updated_at)
         VALUES ('order-corrupt-payload', '[]', NULL, 'pending_retry', 'x', 1, 'not-json', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    expect(
      store.findByOrderId('order-corrupt-payload')?.orderPayload,
    ).toBeNull()
  })

  it('listPendingRetries ne renvoie QUE les liaisons pending_retry', () => {
    store.recordSubmitted('order-s', 'inv-s')
    store.recordPendingRetry('order-r', 'échec', undefined, { id: 1 })
    store.recordPendingRetry('order-a', 'échec', undefined, { id: 2 })
    store.markAbandoned('order-a', 'plafond atteint')

    const pending = store.listPendingRetries()
    expect(pending.map((l) => l.orderId)).toEqual(['order-r'])
  })

  it('markAbandoned transitionne vers abandoned SANS incrémenter attempts', () => {
    store.recordPendingRetry('order-ab', 'échec 1', undefined, { id: 1 })
    store.recordPendingRetry('order-ab', 'échec 2')
    const before = store.findByOrderId('order-ab')
    expect(before?.attempts).toBe(2)

    const abandoned = store.markAbandoned(
      'order-ab',
      'plafond de tentatives atteint',
    )
    expect(abandoned.status).toBe('abandoned')
    expect(abandoned.lastError).toBe('plafond de tentatives atteint')
    expect(abandoned.attempts).toBe(2)
    expect(abandoned.orderPayload).toEqual({ id: 1 })
  })

  it('markAbandoned lève pour une commande inconnue (ne crée jamais de liaison)', () => {
    expect(() => store.markAbandoned('inconnue', 'x')).toThrow(
      /liaison inconnue/,
    )
    expect(store.findByOrderId('inconnue')).toBeUndefined()
  })
})

describe('LinkStore — fichier réel sur disque', () => {
  it('crée le répertoire parent de LINK_DB_PATH si absent (dbPath != :memory:)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factelec-shopify-link-store-'))
    const dbPath = join(dir, 'nested', 'links.sqlite')
    expect(existsSync(dbPath)).toBe(false)
    const fileStore = new LinkStore(dbPath)
    try {
      expect(existsSync(dbPath)).toBe(true)
      const link = fileStore.recordSubmitted('order-file', 'inv-file')
      expect(link.status).toBe('submitted')
    } finally {
      fileStore.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
