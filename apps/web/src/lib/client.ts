import { API_BASE, apiFetch } from './api'
import type {
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
  login: (email: string, password: string) =>
    apiFetch<{ admin: { id: string; email: string } }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  tenants: () => apiFetch<TenantOverview[]>('/admin/tenants'),
}
