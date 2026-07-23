// Options nommées pour les décorateurs @nestjs/swagger de HealthController
// (Task 1, phase 4 it.1) — déclarées hors du contrôleur par cohérence avec
// invoices/invoices.openapi-metadata.ts (aucune contrainte de scan
// d'architecture n'existe ici, HealthController ne posant aucun guard, mais
// même style pour tout le périmètre public).
import type { ApiOperationOptions, ApiResponseOptions } from '@nestjs/swagger'

export const LIVENESS_OPERATION: ApiOperationOptions = {
  summary: 'Sonde de vivacité (liveness)',
  description:
    'Toujours 200, sans dépendance interrogée (ni DB ni Redis) — réponse triviale pour un load-balancer.',
}

export const LIVENESS_RESPONSE: ApiResponseOptions = {
  status: 200,
  description: 'Service démarré.',
  schema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['ok'] } },
    required: ['status'],
  },
}

export const READINESS_OPERATION: ApiOperationOptions = {
  summary: 'Sonde de disponibilité (readiness)',
  description:
    "Vérifie DB, Redis et l'application complète des migrations. 503 si un composant est dégradé (le corps reste renseigné dans les deux cas, jamais de message d'erreur brut).",
}

const readinessComponentSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    latencyMs: { type: 'number' },
  },
  required: ['ok', 'latencyMs'],
}

export const READINESS_RESPONSE: ApiResponseOptions = {
  status: 200,
  description: 'Tous les composants sont sains.',
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      db: readinessComponentSchema,
      redis: readinessComponentSchema,
      migrations: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    },
    required: ['status', 'db', 'redis', 'migrations'],
  },
}

export const READINESS_DEGRADED_RESPONSE: ApiResponseOptions = {
  status: 503,
  description: 'Au moins un composant (DB, Redis ou migrations) est en échec.',
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['degraded'] },
      db: readinessComponentSchema,
      redis: readinessComponentSchema,
      migrations: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    },
    required: ['status', 'db', 'redis', 'migrations'],
  },
}
