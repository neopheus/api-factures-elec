import type { OrderMappingPayload } from '@factelec/connectors-sdk'

// `@factelec/connectors-sdk` en dépendance : SEUL le TYPE `OrderMappingPayload`
// est utilisé (`import type` — effacé à la compilation, AUCUN poids runtime
// ajouté). Nécessité argumentée (design §1) : ce connecteur est le premier à
// consommer le contrat sdk EN TYPESCRIPT DIRECT plutôt qu'un JSON Schema
// dupliqué à la main.

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Résultat de `testConnection()` — sonde AUTHENTIFIÉE (`GET /invoices?limit=1`,
 * leçon it.1/it.2 PHP : un simple `/health` ne prouve pas que la clé API est
 * valide, seulement que l'URL répond). `network-error` couvre aussi bien une
 * panne réseau/timeout qu'un statut HTTP inattendu (ni 200 ni 401) : le
 * contrat demandé (Task 1) ne distingue que ces trois issues, pas un 4e état
 * "unexpected-status" comme les connecteurs PHP.
 */
export type ConnectionTestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unauthorized' | 'network-error' }

/**
 * Erreur typée renvoyée par l'API Factelec (problem-details RFC 9457,
 * `urn:factelec:problem:*` — cf. apps/api/src/common/problem.ts, contrat
 * amont autoritaire, motif FactelecApiException PHP).
 *
 * IMPORTANT sécurité : `message` ne contient JAMAIS la clé API — seuls le
 * statut/titre/détail RENVOYÉS PAR L'API y figurent, jamais les en-têtes de
 * la requête sortante (vérifié par un test dédié).
 */
export class FactelecApiError extends Error {
  constructor(
    readonly problemType: string,
    readonly httpStatus: number,
    readonly title: string,
    readonly problemDetail: string | null = null,
  ) {
    super(
      problemDetail
        ? `[${httpStatus}] ${title} (${problemDetail})`
        : `[${httpStatus}] ${title}`,
    )
    this.name = 'FactelecApiError'
  }
}

/**
 * Client HTTP vers l'API Factelec — fetch natif (zéro dépendance HTTP,
 * philosophie connecteurs), Bearer, timeout 10 s (`AbortSignal.timeout`,
 * natif Node ≥ 22). Motif identique aux connecteurs PrestaShop/WooCommerce
 * (`FactelecClient.php`) : `testConnection`/`submitInvoice`/`getInvoiceStatus`.
 */
export class FactelecClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async testConnection(): Promise<ConnectionTestResult> {
    let response: Response
    try {
      response = await fetch(this.url('/invoices?limit=1'), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      return { ok: false, reason: 'network-error' }
    }
    if (response.status === 200) return { ok: true }
    if (response.status === 401) return { ok: false, reason: 'unauthorized' }
    return { ok: false, reason: 'network-error' }
  }

  /**
   * `POST /invoices` — payload conforme à
   * `packages/connectors-sdk/schema/order-mapping.schema.json`. 201 →
   * identifiant Factelec ; tout autre statut (422/402/403/409...) →
   * `FactelecApiError` typée.
   */
  async submitInvoice(
    payload: OrderMappingPayload,
  ): Promise<{ invoiceId: string }> {
    const response = await fetch(this.url('/invoices'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (response.status === 201) {
      const decoded = await tryDecode(response)
      const id = decoded.id
      if (typeof id !== 'string' || id === '') {
        throw new FactelecApiError(
          'urn:factelec:problem:unexpected-response',
          response.status,
          'Réponse 201 sans identifiant de facture exploitable',
        )
      }
      return { invoiceId: id }
    }

    throw await toApiError(response)
  }

  /** `GET /invoices/:id` — statut de génération, cycle de vie DGFiP courant. */
  async getInvoiceStatus(invoiceId: string): Promise<Record<string, unknown>> {
    const response = await fetch(this.url(`/invoices/${encodeURIComponent(invoiceId)}`), {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 200) return tryDecode(response)
    throw await toApiError(response)
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...extra,
    }
  }
}

async function toApiError(response: Response): Promise<FactelecApiError> {
  const decoded = await tryDecode(response)
  const type =
    typeof decoded.type === 'string'
      ? decoded.type
      : 'urn:factelec:problem:unknown'
  const title =
    typeof decoded.title === 'string' ? decoded.title : 'Erreur API Factelec'
  const detail = typeof decoded.detail === 'string' ? decoded.detail : null
  // `detail` provient EXCLUSIVEMENT du corps de la réponse serveur — jamais
  // des en-têtes de la requête sortante (où transite la clé API).
  return new FactelecApiError(type, response.status, title, detail)
}

/**
 * Décodage tolérant : un corps non-JSON (page d'erreur HTML d'un proxy en
 * amont) ne doit jamais faire planter le client — il retombe sur un objet
 * vide, traité comme "aucun detail exploitable" par `toApiError`.
 */
async function tryDecode(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await response.text()
    if (text === '') return {}
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
