import { describe, expect, it } from 'vitest'
import { envSchema, validateEnv } from '../../src/config/env.js'

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://factelec_app:pw@localhost:5432/factelec',
  CORS_ALLOWED_ORIGINS: 'http://a.example,http://b.example',
  RATE_LIMIT_TTL: '60',
  RATE_LIMIT_LIMIT: '120',
}

describe('validateEnv', () => {
  it('parses and coerces a valid environment', () => {
    const env = validateEnv(base)
    expect(env.PORT).toBe(3000)
    expect(env.RATE_LIMIT_LIMIT).toBe(120)
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([
      'http://a.example',
      'http://b.example',
    ])
  })

  it('applies safe defaults for optional keys', () => {
    const env = validateEnv({ DATABASE_URL: base.DATABASE_URL })
    expect(env.PORT).toBe(3000)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([])
  })

  it('throws listing offending KEYS only (never values — no secret leak)', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrowError(/DATABASE_URL/)
    // le message ne doit contenir aucune valeur d'environnement
    try {
      validateEnv({ DATABASE_URL: 'not-a-url', SECRET: 'p@ssw0rd' })
    } catch (e) {
      expect((e as Error).message).not.toContain('p@ssw0rd')
      expect((e as Error).message).toContain('DATABASE_URL')
    }
  })

  it('defaults TRUST_PROXY to 0 (direct connection, current behavior) when unset', () => {
    const env = validateEnv(base)
    expect(env.TRUST_PROXY).toBe(0)
  })

  it.each(['0', '2'])(
    'accepts a non-negative integer TRUST_PROXY (%s)',
    (v) => {
      const env = validateEnv({ ...base, TRUST_PROXY: v })
      expect(env.TRUST_PROXY).toBe(Number(v))
    },
  )

  it.each(['-1', '1.5', 'abc'])('rejects an invalid TRUST_PROXY (%s)', (v) => {
    expect(() => validateEnv({ ...base, TRUST_PROXY: v })).toThrowError(
      /TRUST_PROXY/,
    )
  })

  it('falls back to the (root) marker when a zod issue carries no field path', () => {
    // Un input qui n'est pas un objet (ex: null) produit une issue racine
    // (path: []) plutôt qu'une issue liée à une clé précise.
    expect(() =>
      validateEnv(null as unknown as Record<string, unknown>),
    ).toThrowError(/\(root\)/)
  })

  it('applies Redis defaults and coerces port', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.REDIS_HOST).toBe('localhost')
    expect(env.REDIS_PORT).toBe(6379)
    expect(env.REDIS_DB).toBe(0)
    expect(env.REDIS_TLS).toBe(false)
    expect(env.GENERATION_JOB_ATTEMPTS).toBe(3)
  })

  it('parses REDIS_TLS strictly (only "true"/"1" enable TLS)', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    expect(validateEnv({ ...base, REDIS_TLS: 'true' }).REDIS_TLS).toBe(true)
    expect(validateEnv({ ...base, REDIS_TLS: '1' }).REDIS_TLS).toBe(true)
    // Piège z.coerce.boolean (toute chaîne non vide → true) NEUTRALISÉ :
    expect(validateEnv({ ...base, REDIS_TLS: 'false' }).REDIS_TLS).toBe(false)
    expect(validateEnv({ ...base, REDIS_TLS: 'no' }).REDIS_TLS).toBe(false)
  })

  it('rejects a non-numeric REDIS_PORT', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_PORT: 'abc',
      }),
    ).toThrow(/REDIS_PORT/)
  })

  it('applies reconciliation defaults (5 min staleness, 1 min sweep cadence)', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.RECONCILIATION_STALE_MS).toBe(300_000)
    expect(env.RECONCILIATION_SWEEP_EVERY_MS).toBe(60_000)
  })

  it('rejects a non-positive RECONCILIATION_STALE_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        RECONCILIATION_STALE_MS: '0',
      }),
    ).toThrow(/RECONCILIATION_STALE_MS/)
  })

  it('applies a wider default staleness for stuck `generating` invoices (15 min)', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.RECONCILIATION_GENERATING_STALE_MS).toBe(900_000)
  })

  it('rejects a non-positive RECONCILIATION_GENERATING_STALE_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        RECONCILIATION_GENERATING_STALE_MS: '0',
      }),
    ).toThrow(/RECONCILIATION_GENERATING_STALE_MS/)
  })

  it('applies archive defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.ARCHIVE_DRIVER).toBe('local')
    expect(env.ARCHIVE_LOCAL_DIR).toBe('./var/archive')
  })

  it('rejects an unknown ARCHIVE_DRIVER', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ARCHIVE_DRIVER: 'ftp',
      }),
    ).toThrow(/ARCHIVE_DRIVER/)
  })

  it('applies the generation reconciliation cap default (5) and the archive retry cadence default (5 min)', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.GENERATION_MAX_ATTEMPTS_CAP).toBe(5)
    expect(env.ARCHIVE_RETRY_EVERY_MS).toBe(300_000)
  })

  it('rejects a non-positive or over-cap GENERATION_MAX_ATTEMPTS_CAP', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        GENERATION_MAX_ATTEMPTS_CAP: '0',
      }),
    ).toThrow(/GENERATION_MAX_ATTEMPTS_CAP/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        GENERATION_MAX_ATTEMPTS_CAP: '51',
      }),
    ).toThrow(/GENERATION_MAX_ATTEMPTS_CAP/)
  })

  it('rejects a non-positive ARCHIVE_RETRY_EVERY_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ARCHIVE_RETRY_EVERY_MS: '0',
      }),
    ).toThrow(/ARCHIVE_RETRY_EVERY_MS/)
  })

  it('applies the routing retry cadence default (5 min)', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.ROUTING_RETRY_EVERY_MS).toBe(300_000)
  })

  it('rejects a non-positive ROUTING_RETRY_EVERY_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ROUTING_RETRY_EVERY_MS: '0',
      }),
    ).toThrow(/ROUTING_RETRY_EVERY_MS/)
  })

  it('applies e-reporting Flux 10 defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.EREPORTING_TRANSMISSION_DRIVER).toBe('local')
    expect(env.EREPORTING_LOCAL_DIR).toBe('./var/ereporting')
    expect(env.EREPORTING_PA_ID).toBe('PA00')
    expect(env.EREPORTING_PA_SCHEME_ID).toBe('0238')
    expect(env.EREPORTING_PA_NAME).toBe('Factelec PA')
    expect(env.EREPORTING_SWEEP_EVERY_MS).toBe(3_600_000)
  })

  it('accepts an override of EREPORTING_TRANSMISSION_DRIVER and EREPORTING_PA_*', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      EREPORTING_TRANSMISSION_DRIVER: 'sftp',
      EREPORTING_PA_ID: 'PA42',
      EREPORTING_PA_NAME: 'Ma PA',
    })
    expect(env.EREPORTING_TRANSMISSION_DRIVER).toBe('sftp')
    expect(env.EREPORTING_PA_ID).toBe('PA42')
    expect(env.EREPORTING_PA_NAME).toBe('Ma PA')
  })

  it('rejects an unknown EREPORTING_TRANSMISSION_DRIVER', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        EREPORTING_TRANSMISSION_DRIVER: 'ftp',
      }),
    ).toThrow(/EREPORTING_TRANSMISSION_DRIVER/)
  })

  it('rejects a non-positive EREPORTING_SWEEP_EVERY_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        EREPORTING_SWEEP_EVERY_MS: '0',
      }),
    ).toThrow(/EREPORTING_SWEEP_EVERY_MS/)
  })

  it('applies annuaire (Flux 13/14) defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.ANNUAIRE_DRIVER).toBe('local')
    expect(env.ANNUAIRE_LOCAL_DIR).toBe('./var/annuaire')
    expect(env.ANNUAIRE_SYNC_EVERY_MS).toBe(86_400_000)
    expect(env.ANNUAIRE_COMPLETE_EVERY_MS).toBe(604_800_000)
    expect(env.ANNUAIRE_PUBLISH_JOB_ATTEMPTS).toBe(3)
    expect(env.ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS).toBe(300_000)
  })

  it('accepts an override of ANNUAIRE_DRIVER', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      ANNUAIRE_DRIVER: 'api',
    })
    expect(env.ANNUAIRE_DRIVER).toBe('api')
  })

  it('rejects an unknown ANNUAIRE_DRIVER', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ANNUAIRE_DRIVER: 'ftp',
      }),
    ).toThrow(/ANNUAIRE_DRIVER/)
  })

  it('rejects a non-positive ANNUAIRE_SYNC_EVERY_MS/ANNUAIRE_COMPLETE_EVERY_MS/ANNUAIRE_PUBLISH_JOB_ATTEMPTS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ANNUAIRE_SYNC_EVERY_MS: '0',
      }),
    ).toThrow(/ANNUAIRE_SYNC_EVERY_MS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ANNUAIRE_COMPLETE_EVERY_MS: '0',
      }),
    ).toThrow(/ANNUAIRE_COMPLETE_EVERY_MS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ANNUAIRE_PUBLISH_JOB_ATTEMPTS: '0',
      }),
    ).toThrow(/ANNUAIRE_PUBLISH_JOB_ATTEMPTS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS: '0',
      }),
    ).toThrow(/ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS/)
  })

  it('applies CDV Flux 6/CDAR transmission defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.CDV_TRANSMISSION_DRIVER).toBe('local')
    expect(env.CDV_LOCAL_DIR).toBe('./var/cdv')
    expect(env.CDV_SWEEP_EVERY_MS).toBe(3_600_000)
    expect(env.CDV_TRANSMISSION_LOOKBACK_MS).toBe(172_800_000)
    expect(env.CDV_TRANSMISSION_JOB_ATTEMPTS).toBe(3)
    expect(env.CDV_STUCK_RETRY_EVERY_MS).toBe(300_000)
    expect(env.CDV_PA_MATRICULE).toBe('0000')
  })

  it('accepts an override of CDV_TRANSMISSION_DRIVER and CDV_PA_MATRICULE', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      CDV_TRANSMISSION_DRIVER: 'as4-peppol',
      CDV_PA_MATRICULE: '1234',
    })
    expect(env.CDV_TRANSMISSION_DRIVER).toBe('as4-peppol')
    expect(env.CDV_PA_MATRICULE).toBe('1234')
  })

  it('rejects an unknown CDV_TRANSMISSION_DRIVER', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CDV_TRANSMISSION_DRIVER: 'ftp',
      }),
    ).toThrow(/CDV_TRANSMISSION_DRIVER/)
  })

  it('rejects a non-positive CDV_SWEEP_EVERY_MS/CDV_TRANSMISSION_LOOKBACK_MS/CDV_TRANSMISSION_JOB_ATTEMPTS/CDV_STUCK_RETRY_EVERY_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CDV_SWEEP_EVERY_MS: '0',
      }),
    ).toThrow(/CDV_SWEEP_EVERY_MS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CDV_TRANSMISSION_LOOKBACK_MS: '0',
      }),
    ).toThrow(/CDV_TRANSMISSION_LOOKBACK_MS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CDV_TRANSMISSION_JOB_ATTEMPTS: '0',
      }),
    ).toThrow(/CDV_TRANSMISSION_JOB_ATTEMPTS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CDV_STUCK_RETRY_EVERY_MS: '0',
      }),
    ).toThrow(/CDV_STUCK_RETRY_EVERY_MS/)
  })

  it('rejects a CDV_TRANSMISSION_JOB_ATTEMPTS above the cap (10)', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CDV_TRANSMISSION_JOB_ATTEMPTS: '11',
      }),
    ).toThrow(/CDV_TRANSMISSION_JOB_ATTEMPTS/)
  })

  it('applies payments (TB-3) sweep defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.PAYMENTS_SWEEP_EVERY_MS).toBe(3_600_000)
    expect(env.PAYMENTS_LOOKBACK_MS).toBe(172_800_000)
  })

  it('rejects a non-positive PAYMENTS_SWEEP_EVERY_MS/PAYMENTS_LOOKBACK_MS', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        PAYMENTS_SWEEP_EVERY_MS: '0',
      }),
    ).toThrow(/PAYMENTS_SWEEP_EVERY_MS/)
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        PAYMENTS_LOOKBACK_MS: '0',
      }),
    ).toThrow(/PAYMENTS_LOOKBACK_MS/)
  })
})

describe('env billing (phase 5)', () => {
  // Seule clé réellement requise (sans .default()/.optional()) dans
  // envSchema à ce jour : DATABASE_URL.
  const BASE = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
  } as const

  it('défauts sûrs : driver none, enforcement off, usage horaire', () => {
    const parsed = envSchema.parse(BASE)
    expect(parsed.BILLING_DRIVER).toBe('none')
    expect(parsed.BILLING_ENFORCEMENT).toBe('off')
    expect(parsed.BILLING_DASHBOARD_URL).toBe('http://localhost:3001')
    expect(parsed.BILLING_USAGE_EVERY_MS).toBe(3_600_000)
    // Fenêtre de rattrapage du sweep d'usage (I2, revue finale phase 5) —
    // défaut 3 j, motif CDV_TRANSMISSION_LOOKBACK_MS.
    expect(parsed.BILLING_USAGE_LOOKBACK_DAYS).toBe(3)
  })

  it('rejette un driver inconnu', () => {
    expect(() =>
      envSchema.parse({ ...BASE, BILLING_DRIVER: 'paypal' }),
    ).toThrow()
  })

  it('rejette un BILLING_USAGE_LOOKBACK_DAYS nul ou négatif (I2)', () => {
    expect(() =>
      envSchema.parse({ ...BASE, BILLING_USAGE_LOOKBACK_DAYS: '0' }),
    ).toThrow(/BILLING_USAGE_LOOKBACK_DAYS/)
    expect(() =>
      envSchema.parse({ ...BASE, BILLING_USAGE_LOOKBACK_DAYS: '-1' }),
    ).toThrow(/BILLING_USAGE_LOOKBACK_DAYS/)
  })

  it('accepte la configuration stripe complète', () => {
    const parsed = envSchema.parse({
      ...BASE,
      BILLING_DRIVER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      STRIPE_PRICE_BASE: 'price_base',
      STRIPE_PRICE_METERED: 'price_metered',
    })
    expect(parsed.BILLING_DRIVER).toBe('stripe')
    expect(parsed.STRIPE_SECRET_KEY).toBe('sk_test_123')
  })
})

describe('env admin/observabilité (phase 5 it.2)', () => {
  // Seule clé réellement requise (sans .default()/.optional()) dans
  // envSchema à ce jour : DATABASE_URL.
  const BASE = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
  } as const

  it('ADMIN_SESSION_TTL_HOURS : défaut 2 (TTL réduit session super admin, dette 1.4 soldée)', () => {
    const parsed = envSchema.parse(BASE)
    expect(parsed.ADMIN_SESSION_TTL_HOURS).toBe(2)
  })

  it('ADMIN_SESSION_TTL_HOURS : accepte la borne max (24)', () => {
    const parsed = envSchema.parse({ ...BASE, ADMIN_SESSION_TTL_HOURS: '24' })
    expect(parsed.ADMIN_SESSION_TTL_HOURS).toBe(24)
  })

  it('ADMIN_SESSION_TTL_HOURS : rejette au-delà de la borne max (25)', () => {
    expect(() =>
      envSchema.parse({ ...BASE, ADMIN_SESSION_TTL_HOURS: '25' }),
    ).toThrow(/ADMIN_SESSION_TTL_HOURS/)
  })

  it('ADMIN_SESSION_TTL_HOURS : rejette une valeur non positive', () => {
    expect(() =>
      envSchema.parse({ ...BASE, ADMIN_SESSION_TTL_HOURS: '0' }),
    ).toThrow(/ADMIN_SESSION_TTL_HOURS/)
  })

  it('METRICS_TOKEN : absent par défaut (opt-in — /metrics répond 404 sans elle)', () => {
    const parsed = envSchema.parse(BASE)
    expect(parsed.METRICS_TOKEN).toBeUndefined()
  })

  it('METRICS_TOKEN : rejette une valeur de moins de 16 caractères (15)', () => {
    expect(() =>
      envSchema.parse({ ...BASE, METRICS_TOKEN: '123456789012345' }),
    ).toThrow(/METRICS_TOKEN/)
  })

  it("METRICS_TOKEN : accepte une valeur d'au moins 16 caractères", () => {
    const parsed = envSchema.parse({
      ...BASE,
      METRICS_TOKEN: '1234567890123456',
    })
    expect(parsed.METRICS_TOKEN).toBe('1234567890123456')
  })
})
