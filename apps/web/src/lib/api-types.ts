export type UserRole = 'owner' | 'admin' | 'accountant' | 'viewer'
export interface UserProfile {
  id: string
  email: string
  role: UserRole
  tenantId: string
  emailVerified: boolean
}
export interface InvoiceSummary {
  id: string
  number: string
  typeCode: string
  issueDate: string
  currency: string
  status: string
  createdAt: string
}
export interface InvoicePage {
  items: InvoiceSummary[]
  nextCursor: string | null
}
export interface InvoiceDetail extends InvoiceSummary {
  availableFormats: string[]
}
export interface ApiKeyView {
  id: string
  prefix: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}
export interface CreatedApiKey extends ApiKeyView {
  token: string
}
export interface TenantOverview {
  id: string
  name: string
  siren: string | null
  createdAt: string
  userCount: number
  invoiceCount: number
}
// Statuts miroir Stripe (Task 5/6 phase 5) — énumération locale, jamais les
// statuts Stripe bruts (mapping serveur : incomplete_expired → canceled,
// paused → unpaid).
export type BillingSubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
export interface BillingStatus {
  status: BillingSubscriptionStatus
  currentPeriodEnd: string | null
  hasCustomer: boolean
}
