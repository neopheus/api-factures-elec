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
// Source UNIQUE du champ `apiKeyId` — interface ÉTROITE explicitement
// importée par les seuls guards concernés (PAS une augmentation globale
// `declare module 'express'`, qui élargirait `apiKeyId` à TOUTE Request du
// projet, l'inverse de l'objectif — AMENDEMENT M3-c). Réutilisée par
// `SessionRequest` (ci-dessous) et `TenantRequest` (api-key.guard.ts) : plus
// aucune duplication du champ.
//
// Contrat figé : `apiKeyId` n'est posé QUE par api-key.guard.ts et
// tenant-auth.guard.ts, UNIQUEMENT après vérification cryptographique de la
// clé API. Il n'est lu pour bypass QUE par roles.guard.ts et csrf.guard.ts
// (`if (req.apiKeyId) return true`, routes dual-auth). Invariant verrouillé
// par apps/api/tests/unit/apikeyid-setters.arch.test.ts.
export interface WithApiKeyId {
  apiKeyId?: string
}

export interface SessionRequest extends Request, WithApiKeyId {
  authUser?: AuthenticatedUser
  authAdmin?: AuthenticatedAdmin
  tenantId?: string // posé pour un user → réutilise @CurrentTenant / runInTenant
}
