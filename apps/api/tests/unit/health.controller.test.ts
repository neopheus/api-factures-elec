import { readFileSync } from 'node:fs'
import type { Queue } from 'bullmq'
import type { Response } from 'express'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HealthController } from '../../src/health/health.controller.js'

// Nombre de migrations ATTENDUES par le journal RÉEL du dépôt — lu ici
// indépendamment du contrôleur (pas de mock de `node:fs`) : le contrôleur
// lit le VRAI fichier au constructeur (motif ereporting-xsd-validator.ts,
// résolution `import.meta.dirname`) ; ce test vérifie donc le comportement
// bout-en-bout de la comparaison, avec un pool `pg` mocké en aval.
const JOURNAL_URL = new URL(
  '../../src/db/migrations/meta/_journal.json',
  import.meta.url,
)
const EXPECTED_MIGRATIONS: number = (
  JSON.parse(readFileSync(JOURNAL_URL, 'utf8')) as { entries: unknown[] }
).entries.length

function fakePool(overrides: {
  select1?: () => Promise<unknown>
  migrationsCount?: () => Promise<unknown>
}): pg.Pool {
  const select1 =
    overrides.select1 ?? (() => Promise.resolve({ rows: [{ '?column?': 1 }] }))
  const migrationsCount =
    overrides.migrationsCount ??
    (() =>
      Promise.resolve({
        rows: [{ count: String(EXPECTED_MIGRATIONS) }],
      }))
  return {
    query: vi.fn((sql: string) =>
      sql.includes('__drizzle_migrations') ? migrationsCount() : select1(),
    ),
  } as unknown as pg.Pool
}

function fakeQueue(ping: () => Promise<string>): Queue {
  return {
    client: Promise.resolve({ ping }),
  } as unknown as Queue
}

interface ReadinessBody {
  status: 'ok' | 'degraded'
  db: { ok: boolean; latencyMs: number }
  redis: { ok: boolean; latencyMs: number }
  migrations: { ok: boolean }
}

function fakeRes(): {
  res: Response
  status: ReturnType<typeof vi.fn>
  body: () => ReadinessBody
} {
  const json = vi.fn()
  const status = vi.fn().mockReturnValue({ json })
  return {
    res: { status } as unknown as Response,
    status,
    body: () => json.mock.calls[0]?.[0],
  }
}

describe('HealthController', () => {
  let controller: HealthController

  beforeEach(() => {
    controller = new HealthController(
      fakePool({}),
      fakeQueue(() => Promise.resolve('PONG')),
    )
  })

  it('GET /health (liveness) renvoie { status: "ok" }, aucune dépendance DB/Redis', () => {
    expect(controller.liveness()).toEqual({ status: 'ok' })
  })

  it('tout est sain → 200, status "ok", db/redis.ok=true avec des latencyMs numériques, migrations.ok=true', async () => {
    const { res, status, body: getBody } = fakeRes()

    await controller.readiness(res)

    expect(status).toHaveBeenCalledWith(200)
    const body = getBody()
    expect(body.status).toBe('ok')
    expect(body.db).toEqual({ ok: true, latencyMs: expect.any(Number) })
    expect(body.redis).toEqual({ ok: true, latencyMs: expect.any(Number) })
    expect(body.migrations).toEqual({ ok: true })
  })

  it('DB en échec (SELECT 1 rejette) → 503, status "degraded", db.ok=false — redis/migrations restent renseignés et à true', async () => {
    controller = new HealthController(
      fakePool({ select1: () => Promise.reject(new Error('ECONNREFUSED')) }),
      fakeQueue(() => Promise.resolve('PONG')),
    )
    const { res, status, body: getBody } = fakeRes()

    await controller.readiness(res)

    expect(status).toHaveBeenCalledWith(503)
    const body = getBody()
    expect(body.status).toBe('degraded')
    expect(body.db).toEqual({ ok: false, latencyMs: expect.any(Number) })
    expect(body.redis.ok).toBe(true)
    expect(body.migrations.ok).toBe(true)
  })

  it('Redis en échec (ping rejette) → 503, status "degraded", redis.ok=false — db/migrations restent renseignés et à true', async () => {
    controller = new HealthController(
      fakePool({}),
      fakeQueue(() => Promise.reject(new Error('connection refused'))),
    )
    const { res, status, body: getBody } = fakeRes()

    await controller.readiness(res)

    expect(status).toHaveBeenCalledWith(503)
    const body = getBody()
    expect(body.status).toBe('degraded')
    expect(body.redis).toEqual({ ok: false, latencyMs: expect.any(Number) })
    expect(body.db.ok).toBe(true)
    expect(body.migrations.ok).toBe(true)
  })

  it('Redis répond autre chose que PONG → 503, redis.ok=false (réponse inattendue traitée comme un échec)', async () => {
    controller = new HealthController(
      fakePool({}),
      fakeQueue(() => Promise.resolve('NOT-PONG')),
    )
    const { res, status, body: getBody } = fakeRes()

    await controller.readiness(res)

    expect(status).toHaveBeenCalledWith(503)
    const body = getBody()
    expect(body.redis.ok).toBe(false)
  })

  it('migrations appliquées ≠ attendues → 503, status "degraded", migrations.ok=false — db/redis restent renseignés et à true', async () => {
    controller = new HealthController(
      fakePool({
        migrationsCount: () => Promise.resolve({ rows: [{ count: '0' }] }),
      }),
      fakeQueue(() => Promise.resolve('PONG')),
    )
    const { res, status, body: getBody } = fakeRes()

    await controller.readiness(res)

    expect(status).toHaveBeenCalledWith(503)
    const body = getBody()
    expect(body.status).toBe('degraded')
    expect(body.migrations).toEqual({ ok: false })
    expect(body.db.ok).toBe(true)
    expect(body.redis.ok).toBe(true)
  })

  it('table drizzle.__drizzle_migrations absente (requête rejette) → migrations.ok=false, PAS un throw/500', async () => {
    controller = new HealthController(
      fakePool({
        migrationsCount: () =>
          Promise.reject(
            new Error('relation "drizzle.__drizzle_migrations" does not exist'),
          ),
      }),
      fakeQueue(() => Promise.resolve('PONG')),
    )
    const { res, status, body: getBody } = fakeRes()

    await expect(controller.readiness(res)).resolves.toBeUndefined()

    expect(status).toHaveBeenCalledWith(503)
    const body = getBody()
    expect(body.migrations).toEqual({ ok: false })
  })

  it('AUCUNE fuite de détail : la réponse ne contient jamais de message d’erreur brut, seulement des booléens/latences (composant down)', async () => {
    controller = new HealthController(
      fakePool({
        select1: () =>
          Promise.reject(
            new Error('secret internal detail, e.g. connection string'),
          ),
      }),
      fakeQueue(() => Promise.reject(new Error('another internal detail'))),
    )
    const { res, body: getBody } = fakeRes()

    await controller.readiness(res)

    const body = getBody()
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('secret internal detail')
    expect(serialized).not.toContain('another internal detail')
    expect(Object.keys(body).sort()).toEqual(
      ['db', 'migrations', 'redis', 'status'].sort(),
    )
    expect(Object.keys(body.db).sort()).toEqual(['latencyMs', 'ok'].sort())
    expect(Object.keys(body.redis).sort()).toEqual(['latencyMs', 'ok'].sort())
    expect(Object.keys(body.migrations)).toEqual(['ok'])
  })
})
