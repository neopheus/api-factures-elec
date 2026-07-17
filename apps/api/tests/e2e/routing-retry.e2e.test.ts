import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplicationContext } from '@nestjs/common'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { RecipientRoutingRetryService } from '../../src/worker/recipient-routing-retry.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker } from './helpers/worker.js'

const input: Omit<InvoiceInput, 'number'> = {
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

// Task 3 (plan 3.4, D7 + AMENDEMENT M-D7-1) : sweep de reprise du routage
// destinataire — miroir EXACT ArchiveRetryService (archive-generation.e2e :
// worker RÉEL via createTestWorker, motif de ce fichier). Vérifie la SD
// cross-tenant `find_pending_routing_invoices` (migration 0028) ET le
// service worker CONTRE un Postgres réel : `pending`+`unaddressable`
// repris ; `ambiguous` JAMAIS balayé ; gate de fraîcheur 15 min ; isolation
// multi-tenant.
describe('sweep de reprise du routage destinataire — pending/unaddressable, ambiguous exclu, gate 15 min, isolation tenant (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let worker: INestApplicationContext
  let repo: InvoicesRepository
  let retry: RecipientRoutingRetryService
  let tenantId: string

  async function seedTenant(name: string): Promise<string> {
    const r = await ownerPool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    return r.rows[0].id
  }

  async function seedGeneratedInvoice(
    tenant: string,
    number: string,
    siren: string,
  ): Promise<string> {
    const invoice = buildInvoice({
      ...input,
      number,
      buyer: { name: 'Acheteur', siren, address: { countryCode: 'FR' } },
    })
    const { id } = await repo.insertReceived(tenant, invoice)
    await repo.markGenerationStatus(tenant, id, 'generated')
    return id
  }

  async function seedDirectoryEntry(
    tenant: string,
    siren: string,
    plateforme: string,
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO annuaire_directory_entries (tenant_id, siren, nature, date_debut, plateforme)
       VALUES ($1, $2, 'D', '20260101', $3)`,
      [tenant, siren, plateforme],
    )
  }

  async function ageInvoice(id: string): Promise<void> {
    await ownerPool.query(
      "UPDATE invoices SET updated_at = now() - interval '1 hour' WHERE id = $1",
      [id],
    )
  }

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    worker = await createTestWorker(db.appUrl, {
      host: redis.host,
      port: redis.port,
    })
    repo = worker.get(InvoicesRepository)
    retry = worker.get(RecipientRoutingRetryService)
    tenantId = await seedTenant('ROUTING-RETRY')
  })
  afterAll(async () => {
    await worker.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('pending → resolved + recipient_platform après sweep, une fois une ligne d’annuaire couvrante seedée', async () => {
    const siren = '611111111'
    const id = await seedGeneratedInvoice(
      tenantId,
      'FA-ROUTING-RETRY-PENDING',
      siren,
    )
    await seedDirectoryEntry(tenantId, siren, '0011')
    await ageInvoice(id)

    const n = await retry.sweepPendingRouting()

    expect(n).toBeGreaterThan(0)
    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'resolved',
      platform: '0011',
    })
  })

  it('unaddressable → resolved si une ligne d’annuaire entre en vigueur entre-temps', async () => {
    const siren = '622222222'
    const id = await seedGeneratedInvoice(
      tenantId,
      'FA-ROUTING-RETRY-UNADDR',
      siren,
    )
    await repo.markRoutingStatus(tenantId, id, 'unaddressable')
    await ageInvoice(id)
    // La ligne d'annuaire n'entre en vigueur qu'APRÈS le premier échec.
    await seedDirectoryEntry(tenantId, siren, '0022')

    await retry.sweepPendingRouting()

    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'resolved',
      platform: '0022',
    })
  })

  it('ambiguous → JAMAIS balayé (reste ambiguous même avec une ligne couvrante et au-delà de la gate 15 min)', async () => {
    const siren = '633333333'
    const id = await seedGeneratedInvoice(
      tenantId,
      'FA-ROUTING-RETRY-AMBIG',
      siren,
    )
    await repo.markRoutingStatus(tenantId, id, 'ambiguous')
    await ageInvoice(id)
    await seedDirectoryEntry(tenantId, siren, '0033')

    await retry.sweepPendingRouting()

    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'ambiguous',
      platform: null,
    })
  })

  it('gate 15 min : une facture pending FRAÎCHE (< 15 min) n’est pas reprise', async () => {
    const siren = '644444444'
    const id = await seedGeneratedInvoice(
      tenantId,
      'FA-ROUTING-RETRY-FRESH',
      siren,
    )
    // Ligne couvrante présente, mais la facture n'est PAS vieillie : la gate
    // de fraîcheur doit l'exclure du balayage.
    await seedDirectoryEntry(tenantId, siren, '0044')

    await retry.sweepPendingRouting()

    expect(await repo.findRoutingState(tenantId, id)).toEqual({
      status: 'pending',
      platform: null,
    })
  })

  it('isolation multi-tenant : le sweep cross-tenant résout chaque facture sous le bon tenant', async () => {
    const tenantA = await seedTenant('ROUTING-RETRY-A')
    const tenantB = await seedTenant('ROUTING-RETRY-B')
    const sirenA = '655555551'
    const sirenB = '655555552'
    const idA = await seedGeneratedInvoice(
      tenantA,
      'FA-ROUTING-RETRY-TENANT-A',
      sirenA,
    )
    const idB = await seedGeneratedInvoice(
      tenantB,
      'FA-ROUTING-RETRY-TENANT-B',
      sirenB,
    )
    await seedDirectoryEntry(tenantA, sirenA, '00AA')
    await seedDirectoryEntry(tenantB, sirenB, '00BB')
    await ageInvoice(idA)
    await ageInvoice(idB)

    await retry.sweepPendingRouting()

    expect(await repo.findRoutingState(tenantA, idA)).toEqual({
      status: 'resolved',
      platform: '00AA',
    })
    expect(await repo.findRoutingState(tenantB, idB)).toEqual({
      status: 'resolved',
      platform: '00BB',
    })
    // Isolation RLS : chaque facture reste invisible sous l'autre tenant.
    expect(await repo.findRoutingState(tenantB, idA)).toBeNull()
    expect(await repo.findRoutingState(tenantA, idB)).toBeNull()
  })
})
