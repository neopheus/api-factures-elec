import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import type { ShopifyConnectorConfig } from './config.js'
import type { LinkStore } from './link-store.js'
import { verifyShopifyWebhookHmac } from './webhook-hmac.js'

// Choix : `node:http` NU plutôt que fastify/express (design §2, « au choix
// argumenté »). Argument : ZÉRO dépendance supplémentaire pour un service à
// deux routes triviales (POST /webhooks/shopify, GET /links) dont la seule
// exigence délicate — lire le corps RAW avant tout parsing JSON pour
// l'HMAC — est justement ce qu'un framework à parsing JSON automatique rend
// pénible à contourner correctement. `node:http` donne un contrôle total et
// explicite sur ce point, cohérent avec la philosophie zéro-dépendance des
// connecteurs (design §2).

export interface ShopifyWebhookMeta {
  topic: string
  shopDomain: string
  webhookId: string | undefined
}

/**
 * Handler injectable — le mapping commande→facture et la soumission
 * Factelec sont hors périmètre de cette tâche (Task 2). Ici : hook no-op
 * qui journalise la réception, pour permettre de vérifier la mécanique
 * HMAC/dédoublonnage/réponses de bout en bout sans dépendre de Task 2.
 */
export type ShopifyWebhookHandler = (
  order: unknown,
  meta: ShopifyWebhookMeta,
) => Promise<void> | void

const defaultWebhookHandler: ShopifyWebhookHandler = (_order, meta) => {
  console.log(
    `[shopify-connector] webhook reçu (topic=${meta.topic}, webhookId=${meta.webhookId ?? 'absent'}) — no-op (mapping/soumission = Task 2)`,
  )
}

export interface CreateServerOptions {
  onWebhook?: ShopifyWebhookHandler
}

const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 Mio — largement au-dessus d'un payload order Shopify réel

export function createServer(
  config: ShopifyConnectorConfig,
  store: LinkStore,
  options: CreateServerOptions = {},
): Server {
  const onWebhook = options.onWebhook ?? defaultWebhookHandler
  return createHttpServer((req, res) => {
    void handleRequest(req, res, config, store, onWebhook)
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ShopifyConnectorConfig,
  store: LinkStore,
  onWebhook: ShopifyWebhookHandler,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal.invalid')
  try {
    if (req.method === 'POST' && url.pathname === '/webhooks/shopify') {
      await handleWebhook(req, res, config, store, onWebhook)
      return
    }
    if (req.method === 'GET' && url.pathname === '/links') {
      handleLinks(req, res, store)
      return
    }
    respondBare(res, 404)
  } catch (error) {
    // 500 nu (aucun détail — design §5), PAS 200 : correctif revue Task 2
    // (I1). `onWebhook` (webhook-handler.ts) capture DÉJÀ tout échec
    // mapping/réseau/API et le persiste en `pending_retry` SANS jamais
    // lever — cette branche n'est donc atteinte QUE si la persistance
    // SQLite elle-même défaille (`findByOrderId`/`recordPendingRetry`
    // lèvent : base verrouillée, disque plein, corruption). Dans ce cas
    // précis, RIEN n'a pu être tracé : répondre 200 dirait à Shopify
    // « reçu et traité » alors que la commande n'a laissé AUCUNE trace —
    // perte silencieuse, exactement la classe d'erreur « Critical it.1 »
    // déplacée sur le chemin de persistance. 500 fait re-livrer Shopify
    // (contrat webhook : non-2xx = nouvelle tentative), ce qui laisse une
    // chance à la persistance de réussir au prochain essai — plus sûr
    // qu'un 200 définitif sur une commande jamais tracée.
    console.error('[shopify-connector] erreur interne non gérée', error)
    if (!res.headersSent) respondBare(res, 500)
  }
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: ShopifyConnectorConfig,
  store: LinkStore,
  onWebhook: ShopifyWebhookHandler,
): Promise<void> {
  const rawBody = await readRawBody(req)

  // HMAC vérifié AVANT tout traitement (design §5) — 401 nu si invalide,
  // aucune autre information.
  const signature = firstHeader(req.headers['x-shopify-hmac-sha256'])
  if (
    !verifyShopifyWebhookHmac(rawBody, config.shopify.webhookSecret, signature)
  ) {
    respondBare(res, 401)
    return
  }

  const topic = firstHeader(req.headers['x-shopify-topic'])
  const shopDomain = firstHeader(req.headers['x-shopify-shop-domain'])
  const webhookId = firstHeader(req.headers['x-shopify-webhook-id'])

  // Topic/shop vérifiés : un événement inattendu (mauvais topic, boutique
  // différente) est ignoré — 200 nu (contrat Shopify, PAS un échec HMAC).
  if (topic !== config.shopify.topic || shopDomain !== config.shopify.shop) {
    console.warn(
      `[shopify-connector] webhook ignoré (topic=${topic ?? '?'}, shop=${shopDomain ?? '?'} inattendu)`,
    )
    respondBare(res, 200)
    return
  }

  // Idempotence par `X-Shopify-Webhook-Id` (re-livraisons Shopify, design
  // §5) — court-circuite AVANT d'invoquer le handler.
  if (webhookId && store.hasProcessedWebhook(webhookId)) {
    console.log(
      `[shopify-connector] webhook déjà traité (webhookId=${webhookId}) — re-livraison ignorée`,
    )
    respondBare(res, 200)
    return
  }

  let order: unknown
  try {
    order = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {}
  } catch {
    console.error('[shopify-connector] corps webhook non-JSON — ignoré')
    respondBare(res, 200)
    return
  }

  await onWebhook(order, { topic, shopDomain, webhookId })
  respondBare(res, 200)
}

// GET /links — diagnostic local (design §4 : pas d'UI marchande en v1).
// Restreint à loopback PAR DÉFAUT : aucune authentification par jeton en
// Task 1 (le jeton local optionnel du design §4 est une limite documentée
// de cette tâche, prévue Task 3) — exposer cet endpoint au-delà de
// localhost sans cette restriction fuiterait le contenu du store (ids de
// commande, dernières erreurs) à quiconque atteint le service.
/** Exportée pour test unitaire direct (la garde 403 non-loopback n'est pas
 * facilement exerçable via une vraie connexion TCP dans ce sandbox de test). */
export function handleLinks(
  req: IncomingMessage,
  res: ServerResponse,
  store: LinkStore,
): void {
  if (!isLoopback(req.socket.remoteAddress)) {
    respondBare(res, 403)
    return
  }
  const body = JSON.stringify(store.listAll())
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(body)
}

/** Exportée pour test unitaire direct (la restriction /links n'est pas
 * facilement exerçable via une vraie connexion TCP non-loopback en test). */
export function isLoopback(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

/** Exportée pour test unitaire direct (garde MAX_BODY_BYTES, motif isLoopback ci-dessus). */
export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function respondBare(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
