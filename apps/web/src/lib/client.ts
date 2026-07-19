import { API_BASE, apiFetch } from './api'
import type {
  AdminAnomaly,
  AdminLoginResult,
  AdminTenantDetail,
  AdminTenantStats,
  AdminTotpConfirmResult,
  ApiKeyView,
  CreatedApiKey,
  InvoiceDetail,
  InvoicePage,
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
  // Task 3 (spec §3) : contrat élargi `{ tenants }` — remplace l'ancien
  // tableau nu `TenantOverview[]` consommé ici avant réparation (Task 11,
  // le contrat serveur avait changé sous ce module en Task 3 sans que le
  // web ne suive : runtime cassé, corrigé par ce module).
  listTenants: () =>
    apiFetch<{ tenants: AdminTenantStats[] }>('/admin/tenants'),
  tenantDetail: (id: string) =>
    apiFetch<AdminTenantDetail>(`/admin/tenants/${id}`),
  // Motif requis côté serveur (1..500, `suspendSchema`) : aucune validation
  // dupliquée ici, le formulaire appelant s'en charge côté UI (spec §3/§4).
  suspend: (id: string, reason: string) =>
    apiFetch<{ suspendedAt: string }>(`/admin/tenants/${id}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unsuspend: (id: string) =>
    apiFetch<void>(`/admin/tenants/${id}/unsuspend`, { method: 'POST' }),
  anomalies: (limit?: number) =>
    apiFetch<{ anomalies: AdminAnomaly[] }>(
      `/admin/anomalies${limit != null ? `?limit=${limit}` : ''}`,
    ),
}
