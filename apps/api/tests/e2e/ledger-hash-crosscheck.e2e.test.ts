import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import {
  computeEventHash,
  genesisHash,
  type StatusEventForHash,
} from '../../src/ledger/ledger-hash.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// KEYSTONE (Task 3, revue Task 2 INFO #4) : ce test prouve que le miroir
// TypeScript (ledger-hash.ts) et le trigger PL/pgSQL seal_status_event
// (migration 0012) produisent EXACTEMENT le même hash chaîné, à l'octet
// près, pour une chaîne réelle scellée par la base. Toute divergence
// (ordre des champs, encodage longueur-préfixée, octets vs caractères,
// troncature ms, Buffer brut vs hex/base64...) fait échouer ce test.

const invoiceInput: InvoiceInput = {
  number: 'FA-XCHECK-1',
  issueDate: '2026-07-14',
  dueDate: '2026-08-13',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
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

interface StoredRow {
  tenant_id: string
  invoice_id: string
  seq: string
  from_status: string | null
  to_status: string
  actor: string
  reason: string | null
  created_at: Date
  prev_hash: Buffer
  hash: Buffer
}

describe('ledger-hash cross-check DB↔Node (e2e, keystone)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantId: string
  let invoiceId: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    const t = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('XCheck') RETURNING id",
    )
    tenantId = t.rows[0].id

    // Chaîne réelle de 3 événements (≥2 requis) via le chemin repository
    // (comme l'application le ferait), scellée par le trigger DB.
    const { id } = await repo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput),
    )
    invoiceId = id
    await repo.recordTransition(
      tenantId,
      invoiceId,
      'deposee',
      'emise',
      'platform',
      undefined,
    )
    await repo.recordTransition(
      tenantId,
      invoiceId,
      'emise',
      'encaissee',
      'user:x',
      'paiement reçu',
    )
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('genesisHash (Node) == prev_hash du seq=1 (DB), byte-for-byte', async () => {
    const rows = (
      await ownerPool.query<StoredRow>(
        'SELECT tenant_id, invoice_id, seq, from_status, to_status, actor, reason, created_at, prev_hash, hash FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq',
        [tenantId],
      )
    ).rows
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]).toBeDefined()

    const expectedGenesis = genesisHash(tenantId)
    expect(expectedGenesis.equals(rows[0]!.prev_hash)).toBe(true)
  })

  it('computeEventHash (Node) == hash stocké (DB) pour CHAQUE maillon, avec linkage prev==hash précédent', async () => {
    const rows = (
      await ownerPool.query<StoredRow>(
        'SELECT tenant_id, invoice_id, seq, from_status, to_status, actor, reason, created_at, prev_hash, hash FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq',
        [tenantId],
      )
    ).rows
    expect(rows.length).toBe(3)

    let expectedPrev = genesisHash(tenantId)
    for (const row of rows) {
      // seq=1 : prev_hash == genesis (re-vérifié ici pour couvrir toute la chaîne).
      expect(expectedPrev.equals(row.prev_hash)).toBe(true)

      const event: StatusEventForHash = {
        tenantId: row.tenant_id,
        invoiceId: row.invoice_id,
        seq: Number(row.seq),
        fromStatus: row.from_status,
        toStatus: row.to_status,
        actor: row.actor,
        reason: row.reason,
        createdAtMs: row.created_at.getTime(),
      }

      const computed = computeEventHash(row.prev_hash, event)
      expect(computed.equals(row.hash)).toBe(true)

      expectedPrev = row.hash
    }
  })

  it('linkage : prev_hash(n) == hash(n-1) (DB, indépendamment du recalcul Node)', async () => {
    const rows = (
      await ownerPool.query<StoredRow>(
        'SELECT seq, prev_hash, hash FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq',
        [tenantId],
      )
    ).rows
    expect(rows.length).toBe(3)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash.equals(rows[i - 1]!.hash)).toBe(true)
    }
  })
})
