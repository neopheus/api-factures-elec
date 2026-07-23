import { z } from 'zod'

// Dépendance runtime `zod` : SEULE dépendance runtime hors `better-sqlite3`
// (design §2 : « deps runtime autorisées : better-sqlite3 ... rien d'autre
// sauf nécessité argumentée »). Nécessité argumentée ici : validation
// fail-fast de l'environnement au boot, MÊME contrat que
// apps/api/src/config/env.ts (validateEnv) — réimplémenter un validateur
// maison serait moins sûr (coercions/bornes numériques, messages d'erreur
// sans fuite de secret) et diverge de la convention du reste du monorepo.

const SHOPIFY_TOPICS = ['orders/paid', 'orders/fulfilled'] as const

const httpsUnlessLocalhost = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  // localhost/127.0.0.1 uniquement — dev local (motif ARCHIVE_DRIVER/local
  // et alentours dans apps/api : les URLs http ne sont tolérées QUE pour un
  // usage de développement, jamais en déploiement réel).
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
}

const envSchema = z.object({
  // ── Custom app Shopify (Admin API) ───────────────────────────────────────
  SHOPIFY_SHOP: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i,
      'SHOPIFY_SHOP doit être un domaine *.myshopify.com',
    ),
  SHOPIFY_ACCESS_TOKEN: z
    .string()
    .min(20, 'SHOPIFY_ACCESS_TOKEN trop court (attendu ≥ 20 caractères)'),
  SHOPIFY_WEBHOOK_SECRET: z
    .string()
    .min(16, 'SHOPIFY_WEBHOOK_SECRET trop court (attendu ≥ 16 caractères)'),
  SHOPIFY_TOPIC: z.enum(SHOPIFY_TOPICS).default('orders/paid'),
  // URL PUBLIQUE (https) de CE service, jamais listée explicitement par le
  // brief mais requise en pratique : `ensureWebhookSubscription` (boot,
  // design §2 « le service enregistre/répare l'abonnement webhook via
  // l'Admin API ») doit fournir à Shopify une adresse joignable DEPUIS LE
  // CLOUD SHOPIFY — jamais localhost, contrairement à FACTELEC_API_URL.
  PUBLIC_WEBHOOK_URL: z
    .url()
    .refine((v) => new URL(v).protocol === 'https:', 'PUBLIC_WEBHOOK_URL doit être en https (adresse joignable par Shopify)'),

  // ── API Factelec (contrat client, motif FactelecClient PHP it.1/it.2) ────
  FACTELEC_API_URL: z
    .url()
    .refine(
      httpsUnlessLocalhost,
      'FACTELEC_API_URL doit être en https (http toléré uniquement pour localhost)',
    ),
  FACTELEC_API_KEY: z
    .string()
    .min(16, 'FACTELEC_API_KEY trop courte (attendu ≥ 16 caractères)'),

  // ── Identité vendeur (BG-4, seller Party du contrat connectors-sdk) ──────
  SELLER_NAME: z.string().min(1, 'SELLER_NAME requis'),
  SELLER_SIREN: z
    .string()
    .regex(/^\d{9}$/, 'SELLER_SIREN doit être composé de 9 chiffres'),
  SELLER_VAT_ID: z.string().optional(),
  SELLER_STREET: z.string().optional(),
  SELLER_CITY: z.string().optional(),
  SELLER_POSTAL_CODE: z.string().optional(),
  SELLER_COUNTRY: z.string().default('FR'),

  // ── Service ───────────────────────────────────────────────────────────
  PORT: z.coerce.number().int().positive().default(3100),
  LINK_DB_PATH: z.string().default('./var/links.sqlite'),
  RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000),
})

export type ShopifyTopic = (typeof SHOPIFY_TOPICS)[number]

/** BG-5 — adresse postale vendeur (miroir PostalAddress, connectors-sdk). */
export interface SellerAddress {
  streetName?: string
  city?: string
  postalCode?: string
  countryCode: string
}

/** BG-4 — vendeur (miroir Party, connectors-sdk). */
export interface SellerConfig {
  name: string
  siren: string
  vatId?: string
  address: SellerAddress
}

export interface ShopifyConnectorConfig {
  shopify: {
    shop: string
    accessToken: string
    webhookSecret: string
    topic: ShopifyTopic
    publicWebhookUrl: string
  }
  factelec: {
    apiUrl: string
    apiKey: string
  }
  seller: SellerConfig
  port: number
  linkDbPath: string
  retryEveryMs: number
}

/**
 * Valide l'environnement au boot (fail-fast, motif validateEnv
 * apps/api/src/config/env.ts) et le restructure en config typée. En cas
 * d'échec, le message ne contient QUE les noms des clés fautives — jamais
 * leurs valeurs (secrets : SHOPIFY_ACCESS_TOKEN, SHOPIFY_WEBHOOK_SECRET,
 * FACTELEC_API_KEY).
 */
export function loadConfig(
  raw: Record<string, string | undefined> = process.env,
): ShopifyConnectorConfig {
  const parsed = envSchema.safeParse(raw)
  if (!parsed.success) {
    const keys = [
      ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
    ]
    throw new Error(
      `Invalid Shopify connector environment configuration: ${keys.join(', ')}`,
    )
  }
  const env = parsed.data
  return {
    shopify: {
      shop: env.SHOPIFY_SHOP,
      accessToken: env.SHOPIFY_ACCESS_TOKEN,
      webhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
      topic: env.SHOPIFY_TOPIC,
      publicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
    },
    factelec: {
      apiUrl: env.FACTELEC_API_URL,
      apiKey: env.FACTELEC_API_KEY,
    },
    seller: {
      name: env.SELLER_NAME,
      siren: env.SELLER_SIREN,
      vatId: env.SELLER_VAT_ID,
      address: {
        streetName: env.SELLER_STREET,
        city: env.SELLER_CITY,
        postalCode: env.SELLER_POSTAL_CODE,
        countryCode: env.SELLER_COUNTRY,
      },
    },
    port: env.PORT,
    linkDbPath: env.LINK_DB_PATH,
    retryEveryMs: env.RETRY_EVERY_MS,
  }
}
