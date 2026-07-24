import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Machine d'états — motif PHP it.1/it.2 (submitted / pending_retry) + un
 * 3e état TERMINAL propre à ce connecteur (Task 2, design §6.2) :
 * `abandoned` — la reprise automatique a atteint son plafond de tentatives
 * (`RETRY_EVERY_MS`/retry-scheduler.ts) ; contrairement aux plugins PHP
 * (bouton BO « Renvoyer » manuel, jamais de plafond), un service headless
 * long-vivant retente automatiquement pour toujours SAUF plafond explicite
 * — au-delà, la commande reste tracée (jamais supprimée) mais n'est plus
 * retentée sans intervention (v1 : pas d'action manuelle de déblocage,
 * limite documentée — cf. rapport Task 2).
 */
export type InvoiceLinkStatus = 'submitted' | 'pending_retry' | 'abandoned'

export interface InvoiceLink {
  orderId: string
  /** `X-Shopify-Webhook-Id` déjà traités pour cette commande (idempotence
   * des re-livraisons Shopify — design §5). */
  webhookIds: string[]
  invoiceId: string | null
  status: InvoiceLinkStatus
  lastError: string | null
  attempts: number
  /**
   * Commande Shopify brute (JSON du webhook), capturée au premier échec —
   * SEULE source permettant de reconstituer le payload de facture au
   * moment d'une reprise (retry-scheduler.ts), SANS dépendre d'un second
   * appel à l'API Shopify (Admin API potentiellement indisponible/
   * commande depuis supprimée — décision Task 2, cf. rapport). `null` tant
   * qu'aucun échec n'a eu lieu (une liaison `submitted` du premier coup n'a
   * jamais besoin d'être reconstituée).
   */
  orderPayload: unknown | null
  createdAt: string
  updatedAt: string
}

interface InvoiceLinkRow {
  order_id: string
  webhook_ids: string
  invoice_id: string | null
  status: InvoiceLinkStatus
  last_error: string | null
  attempts: number
  order_payload: string | null
  created_at: string
  updated_at: string
}

function rowToLink(row: InvoiceLinkRow): InvoiceLink {
  let webhookIds: string[]
  try {
    const parsed: unknown = JSON.parse(row.webhook_ids)
    webhookIds = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    // Corruption défensive : une valeur non-JSON exploitable ne doit jamais
    // faire planter la lecture, seulement dégrader la liste à vide.
    webhookIds = []
  }
  let orderPayload: unknown | null = null
  if (row.order_payload !== null) {
    try {
      orderPayload = JSON.parse(row.order_payload)
    } catch {
      // Même discipline défensive que webhook_ids ci-dessus.
      orderPayload = null
    }
  }
  return {
    orderId: row.order_id,
    webhookIds,
    invoiceId: row.invoice_id,
    status: row.status,
    lastError: row.last_error,
    attempts: row.attempts,
    orderPayload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Store local SQLite (`better-sqlite3`, unique dépendance runtime approuvée
 * hors zod — design §2) de la liaison commande Shopify ↔ facture Factelec.
 * Table `invoice_link` : `order_id` UNIQUE (clé primaire), `webhook_ids`
 * JSON (idempotence des re-livraisons), machine d'états submitted /
 * pending_retry (motif PHP it.1/it.2). `CREATE TABLE IF NOT EXISTS` exécuté
 * au constructeur (boot) — pas de système de migration séparé, contrat
 * volontairement minimal pour un service à une seule table.
 */
export class LinkStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoice_link (
        order_id      TEXT PRIMARY KEY,
        webhook_ids   TEXT NOT NULL DEFAULT '[]',
        invoice_id    TEXT,
        status        TEXT NOT NULL,
        last_error    TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        order_payload TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `)
  }

  close(): void {
    this.db.close()
  }

  findByOrderId(orderId: string): InvoiceLink | undefined {
    const row = this.db
      .prepare('SELECT * FROM invoice_link WHERE order_id = ?')
      .get(orderId) as InvoiceLinkRow | undefined
    return row ? rowToLink(row) : undefined
  }

  /**
   * `X-Shopify-Webhook-Id` déjà vu — TOUTES commandes confondues (Shopify
   * réutilise le même identifiant de webhook à chaque re-livraison du même
   * événement, jamais pour un événement différent). Repose sur `json_each`
   * (extension JSON1, compilée dans better-sqlite3 par défaut).
   */
  hasProcessedWebhook(webhookId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM invoice_link, json_each(invoice_link.webhook_ids)
         WHERE json_each.value = ? LIMIT 1`,
      )
      .get(webhookId)
    return row !== undefined
  }

  listAll(): InvoiceLink[] {
    const rows = this.db
      .prepare('SELECT * FROM invoice_link ORDER BY created_at DESC')
      .all() as InvoiceLinkRow[]
    return rows.map(rowToLink)
  }

  /** Liaisons `pending_retry` — celles que le retry-scheduler (Task 2) balaie. */
  listPendingRetries(): InvoiceLink[] {
    const rows = this.db
      .prepare("SELECT * FROM invoice_link WHERE status = 'pending_retry'")
      .all() as InvoiceLinkRow[]
    return rows.map(rowToLink)
  }

  /**
   * Émission réussie : upsert en `submitted`, remet `last_error` à null.
   * `webhookId` optionnel (Task 1 ne l'exerçait que via les tests directs
   * du store ; le handler webhook réel — Task 2 — le fournit toujours).
   * `orderPayload` optionnel : PRÉSERVE la valeur déjà stockée si omis (le
   * chemin de succès n'a normalement jamais besoin de la (re)fournir).
   */
  recordSubmitted(
    orderId: string,
    invoiceId: string,
    webhookId?: string,
    orderPayload?: unknown,
  ): InvoiceLink {
    return this.upsert(orderId, webhookId, orderPayload, (existing) => ({
      invoiceId,
      status: 'submitted',
      lastError: null,
      attempts: (existing?.attempts ?? 0) + 1,
    }))
  }

  /**
   * Échec (Throwable/réseau/validation) : upsert en `pending_retry`.
   * `orderPayload` : à fournir au PREMIER échec (le handler webhook, qui
   * dispose du JSON brut reçu) — le retry-scheduler (Task 2), qui rejoue un
   * échec déjà tracé, l'omet et la valeur déjà stockée est préservée (seule
   * source disponible pour reconstruire le payload de facture à ce
   * moment-là, cf. docblock `InvoiceLink.orderPayload`).
   */
  recordPendingRetry(
    orderId: string,
    errorMessage: string,
    webhookId?: string,
    orderPayload?: unknown,
  ): InvoiceLink {
    return this.upsert(orderId, webhookId, orderPayload, (existing) => ({
      invoiceId: existing?.invoiceId ?? null,
      status: 'pending_retry',
      lastError: errorMessage,
      attempts: (existing?.attempts ?? 0) + 1,
    }))
  }

  /**
   * Plafond de reprises atteint (retry-scheduler.ts, décision Task 2) :
   * transition TERMINALE vers `abandoned` — la liaison reste tracée
   * (jamais supprimée) mais le scheduler ne la retente plus JAMAIS après
   * ça (aucune action manuelle de déblocage en v1, limite documentée).
   * N'incrémente PAS `attempts` (ce n'est pas une tentative de plus, c'est
   * la CONSTATATION que le plafond des tentatives précédentes est atteint).
   */
  markAbandoned(orderId: string, reason: string): InvoiceLink {
    const existing = this.findByOrderId(orderId)
    if (!existing)
      throw new Error(
        `LinkStore.markAbandoned: liaison inconnue pour order_id=${orderId}`,
      )
    return this.upsert(orderId, undefined, undefined, () => ({
      invoiceId: existing.invoiceId,
      status: 'abandoned',
      lastError: reason,
      attempts: existing.attempts,
    }))
  }

  /**
   * Résultat d'une tentative de reprise (retry périodique, Task 2) sur une
   * liaison déjà `pending_retry`. Lève si `orderId` est inconnu — le retry
   * ne crée jamais de liaison, il n'en fait que transiter une existante.
   */
  markRetried(
    orderId: string,
    outcome: { ok: true; invoiceId: string } | { ok: false; error: string },
  ): InvoiceLink {
    const existing = this.findByOrderId(orderId)
    if (!existing)
      throw new Error(
        `LinkStore.markRetried: liaison inconnue pour order_id=${orderId}`,
      )
    return outcome.ok
      ? this.recordSubmitted(orderId, outcome.invoiceId)
      : this.recordPendingRetry(orderId, outcome.error)
  }

  private upsert(
    orderId: string,
    webhookId: string | undefined,
    orderPayload: unknown | undefined,
    change: (existing: InvoiceLink | undefined) => {
      invoiceId: string | null
      status: InvoiceLinkStatus
      lastError: string | null
      attempts: number
    },
  ): InvoiceLink {
    const existing = this.findByOrderId(orderId)
    const now = new Date().toISOString()
    const webhookIds = mergeWebhookId(existing?.webhookIds ?? [], webhookId)
    // `orderPayload` omis → préserve la valeur déjà stockée (docblock des
    // méthodes publiques ci-dessus) — jamais écrasée par `null` par défaut.
    const resolvedPayload =
      orderPayload !== undefined
        ? orderPayload
        : (existing?.orderPayload ?? null)
    const patch = change(existing)
    this.db
      .prepare(`
        INSERT INTO invoice_link
          (order_id, webhook_ids, invoice_id, status, last_error, attempts, order_payload, created_at, updated_at)
        VALUES (@orderId, @webhookIds, @invoiceId, @status, @lastError, @attempts, @orderPayload, @createdAt, @updatedAt)
        ON CONFLICT(order_id) DO UPDATE SET
          webhook_ids   = excluded.webhook_ids,
          invoice_id    = excluded.invoice_id,
          status        = excluded.status,
          last_error    = excluded.last_error,
          attempts      = excluded.attempts,
          order_payload = excluded.order_payload,
          updated_at    = excluded.updated_at
      `)
      .run({
        orderId,
        webhookIds: JSON.stringify(webhookIds),
        invoiceId: patch.invoiceId,
        status: patch.status,
        lastError: patch.lastError,
        attempts: patch.attempts,
        orderPayload:
          resolvedPayload === null ? null : JSON.stringify(resolvedPayload),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    // biome-ignore lint/style/noNonNullAssertion: on vient d'upserter cette ligne, elle existe forcément.
    return this.findByOrderId(orderId)!
  }
}

function mergeWebhookId(existing: string[], webhookId: string | undefined) {
  if (!webhookId || existing.includes(webhookId)) return existing
  return [...existing, webhookId]
}
