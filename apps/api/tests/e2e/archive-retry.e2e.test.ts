import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArchiveService } from '../../src/archive/archive.service.js'
import { LocalFilesystemArchiveStore } from '../../src/archive/local-filesystem-archive-store.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { ArchiveRetryService } from '../../src/worker/archive-retry.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

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

// Amendement 2 (revue T6 finding #3) : find_failed_archives balaie
// `archive_status='failed'` ET les `pending` STALE (> 15 min) — fenêtre rare
// de double-échec DB où le bundle a pu être écrit mais le marquage final
// (archived, ou son fallback failed) a échoué lui aussi. Un `pending` FRAIS
// (facture en cours d'archivage légitime, jamais > quelques secondes) ne doit
// JAMAIS être ramassé — sinon on concurrencerait un archivage en vol.
describe('archive retry sweep — failed + stale-pending, fresh-pending ignored (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let archive: ArchiveService
  let retry: ArchiveRetryService
  let store: LocalFilesystemArchiveStore
  let dir: string
  let tenantId: string
  let failedId: string
  let stalePendingId: string
  let freshPendingId: string

  async function seedGeneratedInvoice(number: string): Promise<string> {
    const { id } = await repo.insertReceived(
      tenantId,
      buildInvoice({ ...input, number }),
    )
    await repo.markGenerationStatus(tenantId, id, 'generated')
    return id
  }

  beforeAll(async () => {
    db = await startTestDb()
    dir = await mkdtemp(join(tmpdir(), 'factelec-archive-retry-e2e-'))
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool))
    store = new LocalFilesystemArchiveStore(dir)
    archive = new ArchiveService(repo, store)
    retry = new ArchiveRetryService(appPool, archive)
    tenantId = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('ARCHIVE-RETRY') RETURNING id",
      )
    ).rows[0].id

    // 1) archive_status='failed' (échec best-effort classique, Task 6).
    failedId = await seedGeneratedInvoice('FA-RETRY-FAILED')
    await repo.markArchiveStatus(tenantId, failedId, 'failed')

    // 2) archive_status='pending' STALE (> 15 min) — double-échec DB rare.
    stalePendingId = await seedGeneratedInvoice('FA-RETRY-STALE-PENDING')
    await ownerPool.query(
      "UPDATE invoices SET updated_at = now() - interval '1 hour' WHERE id = $1",
      [stalePendingId],
    )

    // 3) archive_status='pending' FRAIS — archivage légitime en vol, ne doit
    // jamais être concurrencé par la reprise.
    freshPendingId = await seedGeneratedInvoice('FA-RETRY-FRESH-PENDING')
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await rm(dir, { recursive: true, force: true })
    await db.stop()
  })

  it('find_failed_archives (SQL, SECURITY DEFINER) returns failed + stale-pending, never fresh-pending', async () => {
    const { rows } = await ownerPool.query(
      'SELECT tenant_id, id FROM find_failed_archives($1)',
      [100],
    )
    const ids = rows.map((r: { id: string }) => r.id)
    expect(ids).toContain(failedId)
    expect(ids).toContain(stalePendingId)
    expect(ids).not.toContain(freshPendingId)
  })

  it('sweepFailedArchives() archives the failed invoice (real ArchiveService + LocalFilesystemArchiveStore)', async () => {
    const n = await retry.sweepFailedArchives()

    expect(n).toBe(2) // failed + stale-pending, jamais le pending frais

    const failedState = await repo.findArchiveState(tenantId, failedId)
    expect(failedState?.status).toBe('archived')
    const bundle = await store.get(`${tenantId}/${failedId}/v1.bundle.json`)
    expect(JSON.parse(bundle.toString('utf8')).version).toBe('v1')
  })

  it('sweepFailedArchives() ALSO archives the stale pending invoice (double-DB-fail reconciliation)', async () => {
    await retry.sweepFailedArchives()

    const state = await repo.findArchiveState(tenantId, stalePendingId)
    expect(state?.status).toBe('archived')
    const bundle = await store.get(
      `${tenantId}/${stalePendingId}/v1.bundle.json`,
    )
    expect(JSON.parse(bundle.toString('utf8')).version).toBe('v1')
  })

  it('sweepFailedArchives() NEVER touches the fresh pending invoice (no race with in-flight archiving)', async () => {
    await retry.sweepFailedArchives()

    const state = await repo.findArchiveState(tenantId, freshPendingId)
    expect(state?.status).toBe('pending')
    await expect(
      store.get(`${tenantId}/${freshPendingId}/v1.bundle.json`),
    ).rejects.toThrow()
  })
})
