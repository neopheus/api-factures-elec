import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArchiveService } from '../../src/archive/archive.service.js'
import type { ArchiveStore } from '../../src/archive/archive-store.port.js'
import { LocalFilesystemArchiveStore } from '../../src/archive/local-filesystem-archive-store.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

const input = {
  number: 'FA-ARCH-1',
  issueDate: '2026-07-14',
  dueDate: '2026-08-13',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'S',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

// Store qui échoue à l'écriture (simule une indisponibilité d'archivage).
const failingStore: ArchiveStore = {
  put: async () => {
    throw new Error('archive down')
  },
  head: async () => ({ exists: false }),
  get: async () => Buffer.alloc(0),
}

async function postInvoice(
  app: INestApplication,
  token: string,
  number: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/invoices')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...input, number })
    .expect(201)
  return res.body.id
}

describe('archive on generation (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let dir: string
  let tenantId: string
  let token: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    dir = await mkdtemp(join(tmpdir(), 'factelec-arch-e2e-'))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool))
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ARCH'))
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await Promise.all([db.stop(), redis.stop()])
  })

  it('archives the invoice after generation (archive_status=archived, bundle written)', async () => {
    const worker = await createTestWorker(db.workerUrl, redis, {
      archiveStore: new LocalFilesystemArchiveStore(dir),
    })
    try {
      const id = await postInvoice(app, token, 'FA-ARCH-OK')
      await waitFor(
        async () =>
          (await repo.findArchiveState(tenantId, id))?.status === 'archived',
        { timeoutMs: 20000, intervalMs: 200 },
      )
      const state = await repo.findArchiveState(tenantId, id)
      expect(state?.location).toContain(`${tenantId}/${id}/v1.bundle.json`)
      // Le bundle est réellement écrit et lisible.
      const buf = await new LocalFilesystemArchiveStore(dir).get(
        `${tenantId}/${id}/v1.bundle.json`,
      )
      const doc = JSON.parse(buf.toString('utf8'))
      expect(doc.version).toBe('v1')
      expect(doc.formats).toHaveLength(5) // 5 formats du socle
      expect(doc.ledger[0]).toMatchObject({ seq: 1, toStatus: 'deposee' })
    } finally {
      await worker.close()
    }
  })

  it('marks archive_status=failed when the store throws, WITHOUT failing generation', async () => {
    const worker = await createTestWorker(db.workerUrl, redis, {
      archiveStore: failingStore,
    })
    try {
      const id = await postInvoice(app, token, 'FA-ARCH-KO')
      // La génération réussit (formats servis) même si l'archivage échoue.
      await waitFor(
        async () => {
          const r = await ownerPool.query(
            'SELECT status FROM invoices WHERE id = $1',
            [id],
          )
          return r.rows[0]?.status === 'generated'
        },
        { timeoutMs: 20000, intervalMs: 200 },
      )
      await waitFor(
        async () =>
          (await repo.findArchiveState(tenantId, id))?.status === 'failed',
        { timeoutMs: 20000, intervalMs: 200 },
      )
    } finally {
      await worker.close()
    }
  })

  it('is idempotent: re-running archive lands on the existing bundle (no overwrite)', async () => {
    // Génère + archive une facture via un premier passage, puis rejoue le service
    // directement : le head détecte la clé, aucun écrasement, statut inchangé.
    const store = new LocalFilesystemArchiveStore(dir)
    const worker = await createTestWorker(db.workerUrl, redis, {
      archiveStore: store,
    })
    let id: string
    try {
      id = await postInvoice(app, token, 'FA-ARCH-IDEM')
      await waitFor(
        async () =>
          (await repo.findArchiveState(tenantId, id))?.status === 'archived',
        { timeoutMs: 20000, intervalMs: 200 },
      )
    } finally {
      await worker.close()
    }
    const key = `${tenantId}/${id}/v1.bundle.json`
    const before = (await store.get(key)).toString('utf8')
    // Rejeu direct du service (real DB + real store).
    await new ArchiveService(repo, store).archiveInvoice(tenantId, id)
    expect((await store.get(key)).toString('utf8')).toBe(before) // aucun écrasement
    expect((await repo.findArchiveState(tenantId, id))?.status).toBe('archived')
  })
})
