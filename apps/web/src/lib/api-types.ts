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
// Ligne de `GET /admin/tenants` (Task 3, phase 5 it.2, spec §3) — remplace
// `TenantOverview` (ancien contrat `{ userCount, invoiceCount }`, cassé par
// le nouveau contrat serveur `{ tenants: AdminTenantStats[] }` livré en
// Task 3 ; réparé ici, Task 11). Dates sérialisées en chaînes ISO par le
// JSON HTTP (comme tout le reste de ce fichier), jamais `Date`.
export interface AdminTenantStats {
  id: string
  name: string
  siren: string | null
  createdAt: string
  suspendedAt: string | null
  billingStatus: BillingSubscriptionStatus
  invoices30d: number
  ereporting30d: number
  deadLetters: number
}
// Facture projetée dans le détail tenant (Task 3, spec §3) — id/number/
// lifecycleStatus/createdAt SEULEMENT, jamais de montant (cf. commentaire
// serveur AdminTenantInvoiceSummary).
export interface AdminTenantInvoiceSummary {
  id: string
  number: string
  lifecycleStatus: string
  createdAt: string
}
// Miroir billing anti-fuite du détail tenant (Task 3, spec §3) :
// `hasCustomer` remplace l'id Stripe brut, jamais renvoyé.
export interface AdminTenantBillingMirror {
  status: BillingSubscriptionStatus
  currentPeriodEnd: string | null
  hasCustomer: boolean
}
// Kinds réels renvoyés par `GET /admin/anomalies` (Task 6, spec §3) —
// 'cdv_parked' couvre les 2 statuts CDV en échec/en attente côté serveur.
export type AdminAnomalyKind =
  | 'dead_letter'
  | 'cdv_parked'
  | 'ereporting_failed'
export interface AdminAnomaly {
  kind: AdminAnomalyKind
  tenantId: string
  refId: string
  detail: string
  createdAt: string
}
// `GET /admin/tenants/:id` (Task 3, spec §3) : stats + 10 dernières
// factures + billing + 20 dernières anomalies du tenant.
export interface AdminTenantDetail extends AdminTenantStats {
  invoices: AdminTenantInvoiceSummary[]
  billing: AdminTenantBillingMirror
  anomalies: AdminAnomaly[]
}
