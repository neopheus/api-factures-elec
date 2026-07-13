import type { Request } from 'express'

export type UserRole = 'owner' | 'admin' | 'accountant' | 'viewer'

export interface AuthenticatedUser {
  sessionId: string
  userId: string
  tenantId: string
  role: UserRole
  csrfHash: string
}
export interface AuthenticatedAdmin {
  sessionId: string
  adminId: string
  csrfHash: string
}
export interface SessionRequest extends Request {
  authUser?: AuthenticatedUser
  authAdmin?: AuthenticatedAdmin
  tenantId?: string // posé pour un user → réutilise @CurrentTenant / runInTenant
  apiKeyId?: string // posé quand TenantAuthGuard authentifie via clé API (aligné sur TenantRequest, 1.3)
}
