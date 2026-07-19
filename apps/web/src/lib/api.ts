import type { BillingStatus } from './api-types'

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000'

export interface ApiProblem {
  type: string
  title: string
  status: number
  detail?: string
  errors?: { path: string; message: string }[]
}

export class ApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.detail ?? problem.title)
    this.name = 'ApiError'
  }
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(/(?:^|;\s*)factelec_csrf=([^;]+)/)
  const value = m?.[1]
  return value ? decodeURIComponent(value) : null
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body != null && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCsrfCookie()
    if (csrf) headers.set('X-CSRF-Token', csrf) // double-submit CSRF
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (res.status === 204) return undefined as T
  const isJson = res.headers.get('content-type')?.includes('json') ?? false
  const payload = isJson ? await res.json() : await res.text()
  if (!res.ok) {
    throw new ApiError(
      isJson && payload && typeof payload === 'object'
        ? (payload as ApiProblem)
        : { type: 'about:blank', title: 'Error', status: res.status },
    )
  }
  return payload as T
}

// Billing (Task 11, phase 5) : lecture du miroir d'abonnement + ouverture
// des sessions hébergées Stripe (Checkout/Portal). Placées ici (et non
// groupées comme `apiKeysApi`/`invoicesApi` dans `client.ts`) à la demande
// explicite du brief Task 11 — seul le statut/checkout/portal billing vivent
// dans ce module, tout le reste des ressources reste dans `client.ts`.
export function getBillingStatus(): Promise<BillingStatus> {
  return apiFetch<BillingStatus>('/billing/status')
}

export function createBillingCheckout(): Promise<{ url: string }> {
  return apiFetch<{ url: string }>('/billing/checkout-session', {
    method: 'POST',
  })
}

export function createBillingPortal(): Promise<{ url: string }> {
  return apiFetch<{ url: string }>('/billing/portal-session', {
    method: 'POST',
  })
}
