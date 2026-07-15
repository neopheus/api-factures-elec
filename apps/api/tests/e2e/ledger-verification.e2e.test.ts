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
import { signupSession } from './helpers/session.js'

const input: InvoiceInput = {
  number: 'FA-LV-1',
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

describe('ledger verification (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantId: string
  let token: string
  let invoiceId: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'LV'))
    invoiceId = await seedGeneratedInvoice(appPool, tenantId, input)
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('returns the sealed events with a valid integrity verdict', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.integrity.valid).toBe(true)
    expect(res.body.events.length).toBeGreaterThanOrEqual(1)
    expect(res.body.events[0]).toMatchObject({ seq: 1, toStatus: 'deposee' })
    expect(res.body.events[0].hash).toMatch(/^[0-9a-f]{64}$/)
    // Identité probative = (tenant_id, seq) : le PK surrogate `id` reste hors
    // périmètre — jamais exposé dans la sérialisation d'un événement.
    expect(res.body.events[0]).not.toHaveProperty('id')
  })

  it('dual-auth: also returns 200 for a session cookie of the same tenant (not just an API key)', async () => {
    // Vérifie explicitement que TenantAuthGuard accepte AUSSI la session (pas
    // seulement la clé API testée ci-dessus) — cf. brief Task 4.
    const email = 'ledger-session@example.com'
    const session = await signupSession(app, {
      email,
      password: 'a-strong-passphrase-123',
      organizationName: 'LV-session',
      siren: null,
    })
    const sessionTenantId = (
      await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
        email,
      ])
    ).rows[0].tenant_id

    // La session appartient à SON PROPRE tenant (signup en a créé un
    // nouveau) — on y sème une facture pour vérifier le dual-auth sans
    // mélanger les tenants.
    const sessionInvoiceId = await seedGeneratedInvoice(
      appPool,
      sessionTenantId,
      {
        ...input,
        number: 'FA-LV-SESSION',
      },
    )

    const res = await request(app.getHttpServer())
      .get(`/invoices/${sessionInvoiceId}/ledger`)
      .set('Cookie', session.cookie)
      .expect(200)
    expect(res.body.integrity.valid).toBe(true)
  })

  it('cross-checks: the DB-sealed hash equals the TS recompute', async () => {
    // La vérif Node (verifyInvoiceEvents) recalcule le hash à partir du prev_hash
    // stocké ; integrity.valid=true prouve DB(pgcrypto) == Node(node:crypto).
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.integrity).toEqual({
      valid: true,
      length: res.body.events.length,
    })
  })

  it('detects owner-side tampering of an event field (hash-mismatch)', async () => {
    // Altération HORS application (accès propriétaire) : le hash ne correspond plus.
    await ownerPool.query(
      "UPDATE invoice_status_events SET actor = 'tampered' WHERE invoice_id = $1 AND seq = 1",
      [invoiceId],
    )
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.integrity).toMatchObject({
      valid: false,
      brokenAtSeq: 1,
      reason: 'hash-mismatch',
    })
  })

  it('404 for an unknown invoice (anti-leak)', async () => {
    await request(app.getHttpServer())
      .get('/invoices/00000000-0000-0000-0000-000000000000/ledger')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })

  // ── Amendement A-IMPORTANT (revue du plan) : chainIntegrity ────────────
  // Le self-check par-facture (verifyInvoiceEvents) NE VOIT PAS une
  // suppression de maillon : chaque événement restant continue de
  // s'auto-vérifier contre son PROPRE prev_hash stocké, intact. Seule la
  // vérification de la chaîne COMPLÈTE du tenant (verifyTenantChain, exposée
  // ici via `chainIntegrity`) révèle le trou de contiguïté. Utilise un
  // tenant/chaîne DÉDIÉS (indépendants du tenant tamponné ci-dessus) pour ne
  // pas confondre les deux scénarios.
  describe('chainIntegrity — owner-side deletion of a chain link', () => {
    let chainTenantId: string
    let chainToken: string
    let invoice3Id: string

    it('happy path: integrity.valid===true AND chainIntegrity.valid===true (length 3) for a 3-event tenant chain', async () => {
      ;({ tenantId: chainTenantId, token: chainToken } =
        await seedTenantWithKey(ownerPool, 'LV-CHAIN'))
      await seedGeneratedInvoice(appPool, chainTenantId, {
        ...input,
        number: 'FA-LV-C1',
      })
      await seedGeneratedInvoice(appPool, chainTenantId, {
        ...input,
        number: 'FA-LV-C2',
      })
      invoice3Id = await seedGeneratedInvoice(appPool, chainTenantId, {
        ...input,
        number: 'FA-LV-C3',
      })

      const res = await request(app.getHttpServer())
        .get(`/invoices/${invoice3Id}/ledger`)
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
        .get(`/invoices/${invoice3Id}/ledger`)
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
