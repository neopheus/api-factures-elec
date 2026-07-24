import type { SellerConfig } from './config.js'
import type { FactelecClient } from './factelec-client.js'
import type { InvoiceLink, LinkStore } from './link-store.js'
import { mapOrder, type ShopifyOrder } from './order-mapper.js'

const DEFAULT_MAX_ATTEMPTS = 10
/** Plafond du multiplicateur de backoff (2^(attempts-1), capé) — au-delà,
 * l'intervalle de reprise n'augmente plus (design §6.2 « backoff simple,
 * plafonné »). 16× `intervalMs` (défaut 300000 ms) = ~80 min entre deux
 * tentatives au pire, raisonnable avant que `attempts` n'atteigne de toute
 * façon `maxAttempts` et bascule en `abandoned`. */
const MAX_BACKOFF_MULTIPLIER = 16

export interface RetrySchedulerDeps {
  store: LinkStore
  client: FactelecClient
  seller: SellerConfig
  intervalMs: number
  maxAttempts?: number
}

export interface RetryScheduler {
  stop(): void
}

/**
 * Reprise automatique périodique (design §6.2) — contrairement aux
 * connecteurs PHP (bouton BO « Renvoyer » manuel, aucun automatisme
 * possible dans le cycle de vie court d'une requête WordPress/PrestaShop),
 * ce service headless long-vivant peut balayer les liaisons `pending_retry`
 * lui-même. `setInterval` sobre (design §2 « backoff simple ») — pas de
 * file de jobs (BullMQ etc., hors philosophie zéro-dépendance connecteurs).
 */
export function startRetryScheduler(deps: RetrySchedulerDeps): RetryScheduler {
  const timer = setInterval(() => {
    void runRetrySweep(deps, Date.now())
  }, deps.intervalMs)
  return { stop: () => clearInterval(timer) }
}

/** Exportée séparément de `startRetryScheduler` pour être testable sans
 * dépendre de vrais timers — prend `now` en paramètre explicite. */
export async function runRetrySweep(
  deps: RetrySchedulerDeps,
  now: number,
): Promise<void> {
  for (const link of deps.store.listPendingRetries()) {
    await retryOne(link, deps, now)
  }
}

async function retryOne(
  link: InvoiceLink,
  deps: RetrySchedulerDeps,
  now: number,
): Promise<void> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  // Plafond atteint : transition TERMINALE, AUCUN appel réseau (design §6.2
  // « skip si attempts >= 10 -> statut abandoned + log »).
  if (link.attempts >= maxAttempts) {
    deps.store.markAbandoned(
      link.orderId,
      `Plafond de tentatives atteint (${maxAttempts}) — reprise automatique abandonnée, intervention manuelle requise.`,
    )
    console.warn(
      `[shopify-connector] order_id=${link.orderId} abandonné après ${link.attempts} tentatives`,
    )
    return
  }

  if (!isDue(link, deps.intervalMs, now)) return

  if (link.orderPayload === null) {
    // Ne devrait jamais arriver (webhook-handler.ts persiste toujours
    // order_payload au premier échec) — filet défensif, aucune tentative
    // réseau sans donnée à soumettre.
    console.error(
      `[shopify-connector] order_id=${link.orderId} sans order_payload exploitable — reprise impossible (filet défensif)`,
    )
    return
  }

  try {
    const payload = mapOrder(link.orderPayload as ShopifyOrder, deps.seller)
    const result = await deps.client.submitInvoice(payload)
    deps.store.markRetried(link.orderId, {
      ok: true,
      invoiceId: result.invoiceId,
    })
    console.log(
      `[shopify-connector] reprise réussie (order_id=${link.orderId}, invoiceId=${result.invoiceId})`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.store.markRetried(link.orderId, { ok: false, error: message })
    console.error(
      `[shopify-connector] reprise en échec (order_id=${link.orderId}, attempts=${link.attempts + 1}) : ${message}`,
    )
  }
}

/**
 * Backoff simple par nombre de tentatives (design §6.2) : attend
 * `intervalMs * min(2^(attempts-1), MAX_BACKOFF_MULTIPLIER)` depuis la
 * dernière mise à jour avant de retenter — évite de marteler à chaque tick
 * une commande persistamment en échec.
 */
function isDue(link: InvoiceLink, intervalMs: number, now: number): boolean {
  const multiplier = Math.min(
    2 ** Math.max(link.attempts - 1, 0),
    MAX_BACKOFF_MULTIPLIER,
  )
  const updatedAtMs = Date.parse(link.updatedAt)
  // Défensif : une date de mise à jour illisible ne doit jamais bloquer
  // indéfiniment une reprise.
  if (Number.isNaN(updatedAtMs)) return true
  return now - updatedAtMs >= intervalMs * multiplier
}
