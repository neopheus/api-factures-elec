import { z } from 'zod'

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Rôle applicatif UNIQUEMENT (soumis à la RLS). L'URL du rôle owner n'est
  // jamais chargée par le process API (elle sert aux scripts migration/provision).
  DATABASE_URL: z.string().url(),
  CORS_ALLOWED_ORIGINS: csv,
  RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().int().positive().default(120),
})

export type EnvConfig = z.infer<typeof envSchema>

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw)
  if (!parsed.success) {
    // On ne divulgue QUE les clés fautives, jamais les valeurs (secrets).
    const keys = [
      ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
    ]
    throw new Error(`Invalid environment configuration: ${keys.join(', ')}`)
  }
  return parsed.data
}
