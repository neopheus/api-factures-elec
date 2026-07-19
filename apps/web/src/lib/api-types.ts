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
// MFA TOTP admin (Task 10, phase 5 it.2). `POST /admin/login` répond soit une
// session (TOTP déjà enrôlé et vérifié), soit une demande d'enrôlement forcé
// — dans ce dernier cas l'API ne pose AUCUNE session (spec §5).
export interface AdminLoginSession {
  admin: { id: string; email: string }
}
export interface AdminEnrollmentRequired {
  enrollmentRequired: true
  otpauthUrl: string
  secret: string
}
export type AdminLoginResult = AdminLoginSession | AdminEnrollmentRequired
// `POST /admin/totp/confirm` : seule et unique apparition des codes de
// récupération en clair — jamais renvoyés par un autre endpoint ensuite.
export interface AdminTotpConfirmResult {
  recoveryCodes: string[]
}
