/**
 * Version Admin API Shopify épinglée (cycle trimestriel Shopify, format
 * YYYY-MM, MM ∈ {01,04,07,10} — chaque version reste supportée environ 12
 * mois). Dernière stable connue à l'écriture de ce fichier. À FAIRE ÉVOLUER
 * MANUELLEMENT lors des dépréciations Shopify — jamais "unstable"/"latest"
 * en production (design §2 : version stable courante épinglée EN CONSTANTE).
 */
const SHOPIFY_ADMIN_API_VERSION = '2025-10'

const REQUEST_TIMEOUT_MS = 10_000

export interface ShopifyWebhookSubscription {
  id: string
  topic: string
  address: string
}

/** Erreur Admin API — le corps brut est conservé pour le log serveur UNIQUEMENT. */
export class ShopifyAdminApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: string,
  ) {
    super(`Shopify Admin API error [${httpStatus}]`)
    this.name = 'ShopifyAdminApiError'
  }
}

interface RawWebhook {
  id: number | string
  topic: string
  address: string
}

/**
 * Client Admin API Shopify minimal — fetch natif, `X-Shopify-Access-Token`
 * (custom app, design §1). AUCUN SDK Shopify lourd (design §2) : seules les
 * deux routes REST nécessaires à l'enregistrement idempotent du webhook
 * entrant sont implémentées.
 */
export class ShopifyAdminClient {
  constructor(
    private readonly shop: string,
    private readonly accessToken: string,
  ) {}

  async listWebhooks(): Promise<ShopifyWebhookSubscription[]> {
    const response = await fetch(this.url('/webhooks.json'), {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new ShopifyAdminApiError(response.status, await safeText(response))
    const body = (await response.json()) as { webhooks?: RawWebhook[] }
    return (body.webhooks ?? []).map(toSubscription)
  }

  async createWebhook(topic: string, address: string): Promise<ShopifyWebhookSubscription> {
    const response = await fetch(this.url('/webhooks.json'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new ShopifyAdminApiError(response.status, await safeText(response))
    const body = (await response.json()) as { webhook: RawWebhook }
    return toSubscription(body.webhook)
  }

  private url(path: string): string {
    return `https://${this.shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'X-Shopify-Access-Token': this.accessToken,
      Accept: 'application/json',
      ...extra,
    }
  }
}

/**
 * Enregistrement idempotent (design §2 : « au démarrage, le service
 * enregistre/répare l'abonnement webhook via l'Admin API (idempotent) ») —
 * liste les abonnements existants, ne crée que si AUCUN n'a déjà le même
 * couple (topic, address). Ne supprime/ne modifie jamais un abonnement
 * existant (réparation = créer ce qui manque, pas reconstruire).
 */
export async function ensureWebhookSubscription(
  client: ShopifyAdminClient,
  topic: string,
  address: string,
): Promise<{ created: boolean; subscription: ShopifyWebhookSubscription }> {
  const existing = await client.listWebhooks()
  const match = existing.find((w) => w.topic === topic && w.address === address)
  if (match) return { created: false, subscription: match }
  const subscription = await client.createWebhook(topic, address)
  return { created: true, subscription }
}

function toSubscription(raw: RawWebhook): ShopifyWebhookSubscription {
  return { id: String(raw.id), topic: raw.topic, address: raw.address }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
