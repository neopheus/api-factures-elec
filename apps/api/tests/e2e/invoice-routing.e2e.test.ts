import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Task 1 (plan 3.3, D2/D3/D4) : persistance du routage destinataire — 2
// colonnes additives sur `invoices` (migration 0026, miroir EXACT du motif
// archive `archiveStatus`/`archiveLocation`), repo `markRoutingStatus`/
// `findRoutingState`, exposition en lecture sur `GET /invoices/:id` SEULE
// (pas la liste — D3).
// Task 2 (D1/D2/D4/D5) : couture `resolveRecipient` dans le worker de
// génération — `RecipientRoutingService.resolveAndRecord` best-effort
// STRICT. NOTE Vitest (plan) : ce fichier démarre des Workers BullMQ (projet
// « heavy », Task 7) — UN SEUL jeu de conteneurs (Postgres+Redis) partagé par
// TOUTES les describes ci-dessous, jamais un jeu par describe.
const input: InvoiceInput = {
  number: 'FA-ROUTING-1',
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

async function postInvoice(
  app: INestApplication,
  token: string,
  overrides: Partial<InvoiceInput>,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/invoices')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...input, ...overrides })
    .expect(201)
  return res.body.id
}

async function seedDirectoryEntry(
  ownerPool: pg.Pool,
  tenantId: string,
  siren: string,
  plateforme: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO annuaire_directory_entries (tenant_id, siren, nature, date_debut, plateforme)
     VALUES ($1, $2, 'D', '20260101', $3)`,
    [tenantId, siren, plateforme],
  )
}

let db: TestDb
let redis: TestRedis
let ownerPool: pg.Pool
let appPool: pg.Pool
let app: INestApplication
let repo: InvoicesRepository
let tenantId: string
let token: string

beforeAll(async () => {
  ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
  ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
  appPool = new pg.Pool({ connectionString: db.appUrl })
  repo = new InvoicesRepository(new TenantContextService(appPool))
  ;({ tenantId, token } = await seedTenantWithKey(ownerPool))
  app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
})
afterAll(async () => {
  await app.close()
  await appPool.end()
  await ownerPool.end()
  await Promise.all([db.stop(), redis.stop()])
})

describe('routage destinataire — persistance + exposition GET (e2e, Postgres réel)', () => {
  it('une facture ingérée a routing_status="pending" et recipient_platform=null par défaut', async () => {
    const invoice = buildInvoice({ ...input, number: 'FA-ROUTING-DEFAULT' })
    const { id } = await repo.insertReceived(tenantId, invoice)

    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'pending',
      platform: null,
    })
  })

  it('GET /invoices/:id expose routingStatus et recipientPlatform', async () => {
    const invoice = buildInvoice({ ...input, number: 'FA-ROUTING-GET' })
    const { id } = await repo.insertReceived(tenantId, invoice)

    const res = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.routingStatus).toBe('pending')
    expect(res.body.recipientPlatform).toBeNull()
  })

  it('markRoutingStatus("resolved", plateforme) puis findRoutingState reflète l’écriture', async () => {
    const invoice = buildInvoice({ ...input, number: 'FA-ROUTING-RESOLVED' })
    const { id } = await repo.insertReceived(tenantId, invoice)

    await repo.markRoutingStatus(tenantId, id, 'resolved', 'PPF')

    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'resolved',
      platform: 'PPF',
    })

    // GET reflète aussi l'écriture (pas seulement le repo direct).
    const res = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.routingStatus).toBe('resolved')
    expect(res.body.recipientPlatform).toBe('PPF')

    // Repasser à `unaddressable` sans plateforme efface la valeur précédente
    // (miroir markArchiveStatus : un état non-résolu ne laisse pas trainer
    // une empreinte stale d'une résolution antérieure).
    await repo.markRoutingStatus(tenantId, id, 'unaddressable')

    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'unaddressable',
      platform: null,
    })
  })

  it('isole le routage par tenant (RLS FORCE) : A invisible sous B', async () => {
    const invoice = buildInvoice({ ...input, number: 'FA-ROUTING-ISOLATION' })
    const { id } = await repo.insertReceived(tenantId, invoice)
    await repo.markRoutingStatus(tenantId, id, 'resolved', 'PPF')

    const { tenantId: otherTenantId } = await seedTenantWithKey(
      ownerPool,
      'Other',
    )

    expect(await repo.findRoutingState(otherTenantId, id)).toBeNull()
  })
})

describe('routage destinataire — couture worker (e2e, Postgres+Redis réels)', () => {
  it('résout le destinataire à la génération : seed ligne annuaire → routing_status="resolved" + recipient_platform', async () => {
    const siren = '511111111'
    await seedDirectoryEntry(ownerPool, tenantId, siren, '0099')
    const worker = await createTestWorker(db.workerUrl, redis)
    try {
      const id = await postInvoice(app, token, {
        number: 'FA-ROUTING-WORKER-RESOLVED',
        buyer: { name: 'Acheteur', siren, address: { countryCode: 'FR' } },
      })
      await waitFor(
        async () =>
          (await repo.findRoutingState(tenantId, id))?.status === 'resolved',
        { timeoutMs: 20000, intervalMs: 200 },
      )
      expect(await repo.findRoutingState(tenantId, id)).toEqual({
        status: 'resolved',
        platform: '0099',
      })
    } finally {
      await worker.close()
    }
  })

  it('sans ligne d\'annuaire couvrante → routing_status="unaddressable" (génération réussie quand même)', async () => {
    const siren = '522222222' // aucune ligne d'annuaire seedée pour ce SIREN
    const worker = await createTestWorker(db.workerUrl, redis)
    try {
      const id = await postInvoice(app, token, {
        number: 'FA-ROUTING-WORKER-UNADDRESSABLE',
        buyer: { name: 'Acheteur', siren, address: { countryCode: 'FR' } },
      })
      await waitFor(
        async () =>
          (await repo.findRoutingState(tenantId, id))?.status ===
          'unaddressable',
        { timeoutMs: 20000, intervalMs: 200 },
      )
      expect(await repo.findRoutingState(tenantId, id)).toEqual({
        status: 'unaddressable',
        platform: null,
      })
      // Génération réussie MALGRÉ la non-adressabilité (D2 : best-effort
      // strict, aucune régression du pipeline d'émission).
      const generationStatus = await ownerPool.query(
        'SELECT status FROM invoices WHERE id = $1',
        [id],
      )
      expect(generationStatus.rows[0]?.status).toBe('generated')
    } finally {
      await worker.close()
    }
  })

  it('non-régression : les formats sont générés et servis indépendamment du routage', async () => {
    const siren = '533333333' // aucune ligne d'annuaire : routage 'unaddressable'
    const worker = await createTestWorker(db.workerUrl, redis)
    try {
      const id = await postInvoice(app, token, {
        number: 'FA-ROUTING-WORKER-FORMATS',
        buyer: { name: 'Acheteur', siren, address: { countryCode: 'FR' } },
      })
      // Attend le routage (dernier pas, après l'archivage) plutôt que le
      // seul statut de génération : garantit que `resolveAndRecord` a fini
      // d'écrire avant l'assertion finale sur `findRoutingState` ci-dessous
      // (évite une race entre `completeGeneration` et la fin du job).
      await waitFor(
        async () =>
          (await repo.findRoutingState(tenantId, id))?.status ===
          'unaddressable',
        { timeoutMs: 20000, intervalMs: 200 },
      )

      const ubl = await request(app.getHttpServer())
        .get(`/invoices/${id}/formats/ubl`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
      expect(ubl.headers['content-type']).toContain('application/xml')
      expect(ubl.text).toContain('<Invoice')

      // Le routage a bien été traité (best-effort), mais AUCUNE incidence
      // sur la disponibilité des formats — même 'unaddressable'.
      expect(await repo.findRoutingState(tenantId, id)).toEqual({
        status: 'unaddressable',
        platform: null,
      })
    } finally {
      await worker.close()
    }
  })
})
