import process from 'node:process'
import { loadConfig } from './config.js'
import { FactelecClient } from './factelec-client.js'
import { LinkStore } from './link-store.js'
import { createServer } from './server.js'
import { ShopifyAdminClient, ensureWebhookSubscription } from './shopify-client.js'

// Bootstrap pur (câblage) — exclu de la couverture (vitest.config.ts), motif
// apps/api/vitest.config.ts (src/main.ts). Séquence design §2/6.1 : config →
// store → sonde Factelec (échec = log explicite SANS SECRET, démarrage
// maintenu) → ensureWebhook (échec = log, démarrage maintenu) → serveur.
// Arrêt propre sur SIGTERM.

async function main(): Promise<void> {
  const config = loadConfig()
  const store = new LinkStore(config.linkDbPath)

  const factelecClient = new FactelecClient(
    config.factelec.apiUrl,
    config.factelec.apiKey,
  )
  const probe = await factelecClient.testConnection()
  if (probe.ok) {
    console.log('[shopify-connector] sonde Factelec OK (GET /invoices?limit=1)')
  } else {
    // `probe.reason` uniquement — jamais FACTELEC_API_KEY (design §5).
    console.error(
      `[shopify-connector] sonde Factelec en échec (${probe.reason}) — démarrage maintenu (état dégradé à investiguer)`,
    )
  }

  const shopifyClient = new ShopifyAdminClient(
    config.shopify.shop,
    config.shopify.accessToken,
  )
  const webhookAddress = new URL(
    '/webhooks/shopify',
    config.shopify.publicWebhookUrl,
  ).toString()
  try {
    const result = await ensureWebhookSubscription(
      shopifyClient,
      config.shopify.topic,
      webhookAddress,
    )
    console.log(
      `[shopify-connector] abonnement webhook ${result.created ? 'créé' : 'déjà présent'} (topic=${config.shopify.topic}, address=${webhookAddress})`,
    )
  } catch (error) {
    console.error(
      '[shopify-connector] échec enregistrement webhook Shopify — démarrage maintenu',
      error instanceof Error ? error.message : error,
    )
  }

  const server = createServer(config, store)
  server.listen(config.port, () => {
    console.log(`[shopify-connector] à l'écoute sur le port ${config.port}`)
  })

  const shutdown = (): void => {
    console.log('[shopify-connector] arrêt (SIGTERM) — fermeture serveur + store')
    server.close(() => {
      store.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[shopify-connector] échec fatal au démarrage', error)
  process.exit(1)
})
