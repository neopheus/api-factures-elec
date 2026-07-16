import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Harmonisation UUID (Task 4, plan 3.3, D7) : les 8 routes ci-dessous
// passaient `:id` brut au repo/service (colonne `uuid`) sans le garde
// `isUuid` déjà appliqué à invoices/lifecycle/api-keys (motif
// `InvoicesService.get`/`LifecycleService.transition`/`ApiKeysService.revoke`)
// → un `:id` malformé faisait échouer le cast Postgres (500). Cible : un
// `:id` malformé produit le MÊME 404 anti-fuite (`toEqual` byte-identique)
// qu'un UUID bien formé mais inconnu — aucune requête SQL n'est exécutée
// dans les deux cas, donc aucune fuite de statut (malformé vs inconnu vs
// cross-tenant restent indiscernables).

const MALFORMED_ID = 'not-a-uuid'
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000'

describe('validation UUID harmonisée des params :id (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let token: string

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool, 'UUID-PARAMS'))
  })
  afterAll(async () => {
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  async function expectByteIdentical404(
    malformedRes: request.Response,
    unknownRes: request.Response,
  ): Promise<void> {
    expect(malformedRes.status).toBe(404)
    expect(unknownRes.status).toBe(404)
    expect(malformedRes.body).toEqual(unknownRes.body)
  }

  it('cdv GET transmissions/:id/xml : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`/cdv/transmissions/${MALFORMED_ID}/xml`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .get(`/cdv/transmissions/${UNKNOWN_UUID}/xml`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('cdv GET transmissions/:id/events : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`/cdv/transmissions/${MALFORMED_ID}/events`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .get(`/cdv/transmissions/${UNKNOWN_UUID}/events`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('ereporting GET transmissions/:id/xml : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${MALFORMED_ID}/xml`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${UNKNOWN_UUID}/xml`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('ereporting GET transmissions/:id/events : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${MALFORMED_ID}/events`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${UNKNOWN_UUID}/events`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('annuaire PUT lignes/:id : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .put(`/annuaire/lignes/${MALFORMED_ID}`)
      .send({ dateFin: '20260601' })
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .put(`/annuaire/lignes/${UNKNOWN_UUID}`)
      .send({ dateFin: '20260601' })
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('annuaire DELETE lignes/:id : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${MALFORMED_ID}`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${UNKNOWN_UUID}`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('ledger GET :id/ledger : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`/invoices/${MALFORMED_ID}/ledger`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .get(`/invoices/${UNKNOWN_UUID}/ledger`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })

  it('ledger GET :id/paf : :id non-UUID → 404 (pas 500), byte-identique à un UUID inconnu', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`/invoices/${MALFORMED_ID}/paf`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app.getHttpServer())
      .get(`/invoices/${UNKNOWN_UUID}/paf`)
      .set('Authorization', `Bearer ${token}`)
    await expectByteIdentical404(malformed, unknown)
  })
})
