import { API_BASE, apiFetch } from './api'
import type {
  AdminLoginResult,
  AdminTotpConfirmResult,
  ApiKeyView,
  CreatedApiKey,
  InvoiceDetail,
  InvoicePage,
  TenantOverview,
  UserProfile,
} from './api-types'

export const authApi = {
  me: () => apiFetch<{ user: UserProfile }>('/auth/me'),
  login: (email: string, password: string) =>
    apiFetch<{ user: UserProfile }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  signup: (input: {
    email: string
    password: string
    organizationName: string
    siren: string | null
  }) =>
    apiFetch<{ user: UserProfile }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  logout: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
}

export const invoicesApi = {
  list: (cursor?: string | null) =>
    apiFetch<InvoicePage>(
      `/invoices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  get: (id: string) => apiFetch<InvoiceDetail>(`/invoices/${id}`),
  formatUrl: (id: string, kind: string) =>
    `${API_BASE}/invoices/${id}/formats/${kind}`,
}

export const apiKeysApi = {
  list: () => apiFetch<ApiKeyView[]>('/api-keys'),
  create: (label: string) =>
    apiFetch<CreatedApiKey>('/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  revoke: (id: string) =>
    apiFetch<void>(`/api-keys/${id}`, { method: 'DELETE' }),
}

export const adminApi = {
  // `code` : saisie unique du formulaire, non distinguée par l'admin — c'est
  // au client de trancher entre TOTP (6 chiffres) et code de récupération
  // (autre format, ex. `xxxx-xxxx`) puisque l'API attend deux champs séparés.
  login: (email: string, password: string, code?: string) =>
    apiFetch<AdminLoginResult>('/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        ...(code
          ? /^\d{6}$/.test(code)
            ? { totpCode: code }
            : { recoveryCode: code }
          : {}),
      }),
    }),
  // Hors session (l'admin n'en a pas encore) : mot de passe redemandé par
  // l'API, cf. spec §5. Seule occurrence des recovery codes en clair.
  confirmTotp: (email: string, password: string, totpCode: string) =>
    apiFetch<AdminTotpConfirmResult>('/admin/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ email, password, totpCode }),
    }),
  tenants: () => apiFetch<TenantOverview[]>('/admin/tenants'),
}
