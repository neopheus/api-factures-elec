import type { InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { seedGeneratedInvoice } from './helpers/seed-invoice.js'

const input: InvoiceInput = {
  number: 'FA-PAF-1',
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

describe('PAF export (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantId: string
  let token: string
  let otherToken: string
  let invoiceId: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'PAF'))
    ;({ token: otherToken } = await seedTenantWithKey(ownerPool, 'OTHER'))
    invoiceId = await seedGeneratedInvoice(appPool, tenantId, input)
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('returns a JSON PAF with events, integrity, chainIntegrity and archive state', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/paf`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.invoiceId).toBe(invoiceId)
    expect(res.body.lifecycleStatus).toBe('deposee')
    expect(res.body.integrity.valid).toBe(true)
    expect(res.body.chainIntegrity.valid).toBe(true)
    expect(res.body.events[0]).toMatchObject({ seq: 1, toStatus: 'deposee' })
    // Identité probative = (tenant_id, seq) : le PK surrogate `id` reste hors
    // périmètre — jamais exposé dans un événement du PAF.
    expect(res.body.events[0]).not.toHaveProperty('id')
    expect(res.body.archive.status).toMatch(/pending|archived/)
  })

  it('returns a CSV PAF as an attachment (RFC 4180 event table, no integrity/archive columns)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/paf?format=csv`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.headers['content-disposition']).toContain(`paf-${invoiceId}.csv`)
    const lines = res.text.trimEnd().split('\n')
    expect(lines[0]).toBe(
      'seq,from_status,to_status,actor,reason,created_at,prev_hash,hash',
    )
    expect(lines[1]).toMatch(/^1,,deposee,platform,,/)
  })

  it('isolates tenants: another tenant cannot read this PAF (404)', async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/paf`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)
  })

  it('404 for an unknown invoice (anti-leak)', async () => {
    await request(app.getHttpServer())
      .get('/invoices/00000000-0000-0000-0000-000000000000/paf')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })

  // ── Amendement A-IMPORTANT (revue du plan, brief Task 7) : chainIntegrity ──
  // Le self-check par-facture (integrity) NE détecte PAS une suppression
  // owner-side de maillon : chaque événement restant continue de
  // s'auto-vérifier contre son PROPRE prev_hash stocké, intact. Seule la
  // vérification de la chaîne COMPLÈTE du tenant (chainIntegrity) révèle le
  // trou de contiguïté — d'où l'obligation de porter les DEUX verdicts dans
  // le PAF.
  describe('chainIntegrity — owner-side deletion of a chain link', () => {
    let chainTenantId: string
    let chainToken: string
    let invoice3Id: string

    it('happy path: integrity.valid===true AND chainIntegrity.valid===true for a 3-event tenant chain', async () => {
      ;({ tenantId: chainTenantId, token: chainToken } =
        await seedTenantWithKey(ownerPool, 'PAF-CHAIN'))
      await seedGeneratedInvoice(appPool, chainTenantId, {
        ...input,
        number: 'FA-PAF-C1',
      })
      await seedGeneratedInvoice(appPool, chainTenantId, {
        ...input,
        number: 'FA-PAF-C2',
      })
      invoice3Id = await seedGeneratedInvoice(appPool, chainTenantId, {
        ...input,
        number: 'FA-PAF-C3',
      })

      const res = await request(app.getHttpServer())
        .get(`/invoices/${invoice3Id}/paf`)
        .set('Authorization', `Bearer ${chainToken}`)
        .expect(200)

      expect(res.body.integrity).toEqual({ valid: true, length: 1 })
      expect(res.body.chainIntegrity).toEqual({ valid: true, length: 3 })
    })

    it('owner-side DELETE of the seq=2 link: per-invoice integrity STAYS valid, chainIntegrity flags {valid:false, brokenAtSeq:3, reason:"seq-gap"}', async () => {
      await ownerPool.query(
        'DELETE FROM invoice_status_events WHERE tenant_id = $1 AND seq = 2',
        [chainTenantId],
      )

      const res = await request(app.getHttpServer())
        .get(`/invoices/${invoice3Id}/paf`)
        .set('Authorization', `Bearer ${chainToken}`)
        .expect(200)

      // Contraste-clé : l'auto-check de invoice3 reste valide (son propre
      // événement s'auto-vérifie contre son prev_hash stocké, intact)...
      expect(res.body.integrity).toEqual({ valid: true, length: 1 })
      // ...alors que la chaîne complète du tenant révèle la suppression.
      expect(res.body.chainIntegrity).toEqual({
        valid: false,
        brokenAtSeq: 3,
        reason: 'seq-gap',
      })
    })
  })
})
