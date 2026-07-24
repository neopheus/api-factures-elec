import type { SellerConfig } from './config.js'
import type { FactelecClient } from './factelec-client.js'
import type { LinkStore } from './link-store.js'
import { mapOrder, type ShopifyOrder } from './order-mapper.js'
import type { ShopifyWebhookHandler } from './server.js'

export interface WebhookHandlerDeps {
  store: LinkStore
  client: FactelecClient
  seller: SellerConfig
}

/**
 * Handler webhook réel (Task 2, design §6.2) — remplace le no-op de
 * Task 1. PORTE le correctif CRITIQUE de la revue it.1
 * (`OrderEmissionService.php::submitNewOrder`, motif IDENTIQUE) : mapping
 * ET soumission dans un SEUL bloc try/catch large — une panne réseau
 * (fetch rejette une `TypeError`, jamais une `FactelecApiError`) ne doit
 * JAMAIS traverser silencieusement ce handler, sous peine de perdre la
 * commande sans aucune trace `pending_retry`.
 *
 * Idempotence à DEUX niveaux (design §5) :
 *   1. `X-Shopify-Webhook-Id` — déjà vérifié par `server.ts` AVANT
 *      d'invoquer ce handler (court-circuite les re-livraisons Shopify).
 *   2. `order_id` — vérifié ICI, AVANT tout mapping (motif
 *      `OrderEmissionService::submitNewOrder`) : une commande déjà liée
 *      (`submitted`, `pending_retry` OU `abandoned`) n'est JAMAIS
 *      re-mappée ni re-soumise, quel que soit l'événement qui a déclenché
 *      l'appel.
 */
export function createWebhookHandler(
  deps: WebhookHandlerDeps,
): ShopifyWebhookHandler {
  return async (order, meta) => {
    const orderId = extractOrderId(order)
    if (orderId === undefined) {
      // Aucune trace possible sans identifiant — cas structurel non prévu
      // par Shopify (id toujours présent en pratique), défensif uniquement.
      console.error(
        '[shopify-connector] webhook order sans id exploitable — ignoré',
      )
      return
    }

    if (deps.store.findByOrderId(orderId) !== undefined) {
      console.log(
        `[shopify-connector] commande déjà liée (order_id=${orderId}) — no-op`,
      )
      return
    }

    try {
      const payload = mapOrder(order as ShopifyOrder, deps.seller)
      const result = await deps.client.submitInvoice(payload)
      deps.store.recordSubmitted(
        orderId,
        result.invoiceId,
        meta.webhookId,
        order,
      )
      console.log(
        `[shopify-connector] facture émise (order_id=${orderId}, invoiceId=${result.invoiceId})`,
      )
    } catch (error) {
      // `error.message` seul est stocké — ni FactelecApiError (jamais la
      // clé API, cf. factelec-client.ts) ni les erreurs réseau natives ne
      // portent de secret.
      const message = error instanceof Error ? error.message : String(error)
      deps.store.recordPendingRetry(orderId, message, meta.webhookId, order)
      console.error(
        `[shopify-connector] émission en échec (order_id=${orderId}) — pending_retry : ${message}`,
      )
    }
  }
}

function extractOrderId(order: unknown): string | undefined {
  if (typeof order !== 'object' || order === null) return undefined
  const id = (order as { id?: unknown }).id
  if (typeof id === 'string' && id !== '') return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return undefined
}
