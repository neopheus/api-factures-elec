import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PURGE_SESSIONS_JOB } from '../../src/queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../../src/queue/queue.constants.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

describe('expired session purge (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantId: string
  let userId: string

  async function seedSession(tokenHash: string, expiresAt: string) {
    await ownerPool.query(
      `INSERT INTO sessions (user_id, tenant_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, 'csrf', $4)`,
      [userId, tenantId, tokenHash, expiresAt],
    )
  }

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    const t = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('T') RETURNING id",
    )
    tenantId = t.rows[0].id
    const u = await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'u@ex.com', 'x', 'owner') RETURNING id",
      [tenantId],
    )
    userId = u.rows[0].id
    await seedSession(
      'expired-hash',
      new Date(Date.now() - 3_600_000).toISOString(),
    )
    await seedSession(
      'valid-hash',
      new Date(Date.now() + 3_600_000).toISOString(),
    )
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('factelec_app cannot DELETE sessions directly — deny-all RLS, only the SD function can', async () => {
    await expect(
      appPool.query("DELETE FROM sessions WHERE token_hash = 'expired-hash'"),
    ).rejects.toThrow(/permission denied/i)
  })

  it('the maintenance worker deletes expired sessions but keeps valid ones', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      // Le scheduler a enregistré le planificateur périodique (idempotent).
      const schedulers = await queue.getJobSchedulers()
      expect(
        schedulers.some(
          (s) => s.key === 'session-purge' || s.name === PURGE_SESSIONS_JOB,
        ),
      ).toBe(true)

      // Déclenchement immédiat (job ponctuel, sans attendre l'intervalle).
      await queue.add(PURGE_SESSIONS_JOB, {})
      await waitFor(async () => {
        const r = await ownerPool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'expired-hash'",
        )
        return r.rows[0].n === 0
      })
      const valid = await ownerPool.query(
        "SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'valid-hash'",
      )
      expect(valid.rows[0].n).toBe(1)
    } finally {
      await queue.close()
      await worker.close()
    }
  })
})
