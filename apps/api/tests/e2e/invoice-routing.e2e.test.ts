import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Task 1 (plan 3.3, D2/D3/D4) : persistance du routage destinataire — 2
// colonnes additives sur `invoices` (migration 0026, miroir EXACT du motif
// archive `archiveStatus`/`archiveLocation`), repo `markRoutingStatus`/
// `findRoutingState`, exposition en lecture sur `GET /invoices/:id` SEULE
// (pas la liste — D3). Aucune couture worker ici (Task 2) : ces tests
// n'exercent QUE la persistance/lecture, jamais la résolution best-effort.
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

describe('routage destinataire — persistance + exposition GET (e2e, Postgres réel)', () => {
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
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

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
