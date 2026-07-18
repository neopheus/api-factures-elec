import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { extractCookie, signupSession } from './helpers/session.js'

// Task 4 (plan 3.5, D6) : endpoint opérateur `POST /invoices/:id/routing/resolve`
// — LIGHT (Postgres réel SEUL, aucun `createTestWorker`/Redis, motif EXACT
// `ereporting-retransmission-endpoint.e2e.test.ts`) : l'appel est un
// `resolveAndRecord` DIRECT (pas d'enfilement), donc aucune infrastructure
// worker n'est nécessaire pour l'exercer bout-en-bout avec un ANNUAIRE réel.
const input: InvoiceInput = {
  number: 'placeholder',
  issueDate: '2026-07-13',
  dueDate: '2026-08-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'Service',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

async function seedDirectoryEntry(
  pool: pg.Pool,
  tenantId: string,
  siren: string,
  plateforme: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO annuaire_directory_entries (tenant_id, siren, nature, date_debut, plateforme)
     VALUES ($1, $2, 'D', '20260101', $3)`,
    [tenantId, siren, plateforme],
  )
}

let db: TestDb
let ownerPool: pg.Pool
let appPool: pg.Pool
let app: INestApplication
let repo: InvoicesRepository
let tenantId: string
let token: string

beforeAll(async () => {
  db = await startTestDb()
  ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
  appPool = new pg.Pool({ connectionString: db.appUrl })
  repo = new InvoicesRepository(new TenantContextService(appPool))
  ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ROUTING-RESOLVE'))
  app = await createTestApp(db.appUrl)
})
afterAll(async () => {
  await app.close()
  await appPool.end()
  await ownerPool.end()
  await db.stop()
})

async function seedAmbiguousInvoice(
  number: string,
  siren: string,
): Promise<string> {
  const invoice = buildInvoice({
    ...input,
    number,
    buyer: { name: 'Acheteur', siren, address: { countryCode: 'FR' } },
  })
  const { id } = await repo.insertReceived(tenantId, invoice)
  await repo.markRoutingStatus(tenantId, id, 'ambiguous')
  return id
}

const resolve = (id: string) =>
  request(app.getHttpServer())
    .post(`/invoices/${id}/routing/resolve`)
    .set('Authorization', `Bearer ${token}`)

describe('POST /invoices/:id/routing/resolve (e2e, Postgres+annuaire réels, LIGHT)', () => {
  it('facture ambiguous + annuaire nettoyé (une seule ligne couvrante) → 200 {routingStatus:"resolved", recipientPlatform}', async () => {
    const siren = '811111111'
    const id = await seedAmbiguousInvoice('FA-RESOLVE-CLEANED', siren)
    await seedDirectoryEntry(ownerPool, tenantId, siren, '0055')

    const res = await resolve(id).expect(200)

    expect(res.body).toEqual({
      invoiceId: id,
      routingStatus: 'resolved',
      recipientPlatform: '0055',
    })
    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'resolved',
      platform: '0055',
    })
  })

  // Honnêteté (D6/L1) : le 200 « toujours ambiguous » doit être INDISTINCT
  // entre « annuaire pas nettoyé » et « panne opérationnelle pendant le
  // best-effort ». Note d'implémentation (task-4-report.md, décision
  // documentée) : reproduire une VRAIE ambiguïté structurelle persistante
  // via des lignes d'annuaire réellement seedées est ARCHITECTURALEMENT
  // IRRÉALISABLE dans ce schéma — l'index unique
  // `annuaire_directory_entries_maille_date_nature_unique` interdit deux
  // lignes 'D' à la même maille+date (le cas `winnersByMailleKey`), et
  // `coversTarget` n'admet jamais plus d'une mailleKey couvrante par rang
  // pour une cible dérivée d'un acheteur de facture (le cas `mostSpecific`)
  // — aucune des deux formes d'`AmbiguousResolutionError` n'est donc
  // ré-atteignable avec des données réelles respectant la contrainte. Ce
  // test exerce donc le MÊME embranchement best-effort (D2, catch-all
  // opérationnel qui laisse `routing_status` INCHANGÉ) via un canonical
  // corrompu (clé `buyer` retirée après coup, cas réaliste de donnée
  // héritée/malformée) — code non mocké, Postgres réel, AUCUN test double
  // sur `RecipientRoutingService`/`AnnuaireConsultationService`.
  it('facture ambiguous SANS nettoyage (toujours ambiguë) → 200 {routingStatus:"ambiguous"} (aucune promesse fabriquée)', async () => {
    const siren = '822222222'
    const id = await seedAmbiguousInvoice('FA-RESOLVE-UNCLEANED', siren)
    await ownerPool.query(
      `UPDATE invoices SET canonical = canonical - 'buyer' WHERE id = $1`,
      [id],
    )

    const res = await resolve(id).expect(200)

    expect(res.body).toEqual({
      invoiceId: id,
      routingStatus: 'ambiguous',
      recipientPlatform: null,
    })
    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'ambiguous',
      platform: null,
    })
  })

  it('facture resolved/pending/unaddressable → 409, jamais ambiguous', async () => {
    for (const status of ['resolved', 'pending', 'unaddressable'] as const) {
      const invoice = buildInvoice({
        ...input,
        number: `FA-RESOLVE-409-${status}`,
        buyer: {
          name: 'Acheteur',
          siren: '833333333',
          address: { countryCode: 'FR' },
        },
      })
      const { id } = await repo.insertReceived(tenantId, invoice)
      await repo.markRoutingStatus(tenantId, id, status)

      const res = await resolve(id).expect(409)
      expect(res.body.type).toBe('urn:factelec:problem:conflict')
    }
  })

  it('facture d’un autre tenant → 404 byte-identique (anti-fuite)', async () => {
    const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'
    const unknown = await resolve(UNKNOWN_ID).expect(404)

    const id = await seedAmbiguousInvoice(
      'FA-RESOLVE-CROSS-TENANT',
      '844444444',
    )
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'ROUTING-RESOLVE-OTHER',
    )
    const crossTenant = await request(app.getHttpServer())
      .post(`/invoices/${id}/routing/resolve`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)

    expect(unknown.body).toEqual(crossTenant.body)
    expect(unknown.headers['content-type']).toContain(
      'application/problem+json',
    )
  })

  it(':id malformé (non-UUID) → 404', async () => {
    await resolve('not-a-uuid').expect(404)
  })

  it('401 : sans authentification', async () => {
    const id = await seedAmbiguousInvoice('FA-RESOLVE-NOAUTH', '855555555')
    await request(app.getHttpServer())
      .post(`/invoices/${id}/routing/resolve`)
      .expect(401)
  })

  it('403 : mutation de session sans le header CSRF (motif payments/retransmissions)', async () => {
    const id = await seedAmbiguousInvoice('FA-RESOLVE-NOCSRF', '866666666')
    const session = await signupSession(app, {
      email: 'routing-resolve-csrf@example.com',
      password: 'a-strong-password-1',
      organizationName: 'ROUTING-RESOLVE-CSRF',
    })
    await request(app.getHttpServer())
      .post(`/invoices/${id}/routing/resolve`)
      .set('Cookie', session.cookie)
      .expect(403)
  })

  it('403 : un rôle viewer ne peut pas re-résoudre le routage', async () => {
    const id = await seedAmbiguousInvoice('FA-RESOLVE-VIEWER', '877777777')
    const signup = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({
        email: 'routing-resolve-owner@example.com',
        password: 'a-strong-password-1',
        organizationName: 'ROUTING-RESOLVE-VIEWER',
      })
      .expect(201)
    const viewerTenantId = signup.body.user.tenantId as string
    await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'routing-resolve-viewer@example.com', $2, 'viewer')",
      [viewerTenantId, await hashPassword('a-strong-password-1')],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'routing-resolve-viewer@example.com',
        password: 'a-strong-password-1',
      })
      .expect(200)
    const vCookie = login.headers['set-cookie'] as unknown as string[]
    await request(app.getHttpServer())
      .post(`/invoices/${id}/routing/resolve`)
      .set('Cookie', vCookie)
      .set('X-CSRF-Token', extractCookie(vCookie, 'factelec_csrf'))
      .expect(403)
  })

  // « clé API → OK » (brief, groupe dual-auth) : déjà PROUVÉ par chacun des
  // tests de succès ci-dessus (`resolve()` authentifie systématiquement via
  // `Bearer ${token}`, motif de clé API) — pas de test dédié redondant.
})
