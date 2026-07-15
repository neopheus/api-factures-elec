import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const invoiceInput: InvoiceInput = {
  number: 'FA-SEAL-1',
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

describe('invoice_status_events sealing (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    const a = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('A') RETURNING id",
    )
    tenantA = a.rows[0].id
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('has pgcrypto available (digest sha256)', async () => {
    const r = await ownerPool.query(
      "SELECT encode(digest('abc','sha256'),'hex') AS h",
    )
    expect(r.rows[0].h).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('forbids deleting an invoice that has a probative journal (23503)', async () => {
    const { id } = await repo.insertReceived(
      tenantA,
      buildInvoice(invoiceInput),
    )
    // insertReceived a écrit l'événement initial `deposee` → la FK RESTRICT
    // bloque la suppression, même pour l'owner (BYPASSRLS n'exempte pas des FK).
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  // Asymétrie RESTRICT (revue Task 1) : sans événement enfant, la suppression
  // réussit — le RESTRICT ne bloque QUE lorsque des enfants existent.
  it('allows deleting an invoice that has NO journal event (RESTRICT asymmetry)', async () => {
    const inv = await ownerPool.query(
      "INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical) VALUES ($1,'FA-NOEVT','380','2026-07-14','EUR','{}'::jsonb) RETURNING id",
      [tenantA],
    )
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [inv.rows[0].id]),
    ).resolves.toBeDefined()
  })

  it('seals the initial event: seq=1, genesis prev_hash, hash present', async () => {
    const t = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('S1') RETURNING id",
      )
    ).rows[0].id
    const { id } = await repo.insertReceived(
      t,
      buildInvoice({ ...invoiceInput, number: 'FA-SEAL-S1' }),
    )
    const ev = await ownerPool.query(
      "SELECT seq, encode(prev_hash,'hex') AS prev, encode(hash,'hex') AS h FROM invoice_status_events WHERE invoice_id = $1",
      [id],
    )
    expect(ev.rows).toHaveLength(1)
    expect(Number(ev.rows[0].seq)).toBe(1)
    // genesis = sha256('factelec:ledger:genesis:v1:' || tenantId)
    const genesis = (
      await ownerPool.query(
        "SELECT encode(digest('factelec:ledger:genesis:v1:' || $1, 'sha256'),'hex') AS g",
        [t],
      )
    ).rows[0].g
    expect(ev.rows[0].prev).toBe(genesis)
    expect(ev.rows[0].h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('chains events per tenant: seq monotone, prev_hash = previous hash', async () => {
    const t = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('S2') RETURNING id",
      )
    ).rows[0].id
    const { id } = await repo.insertReceived(
      t,
      buildInvoice({ ...invoiceInput, number: 'FA-SEAL-S2' }),
    )
    await repo.recordTransition(
      t,
      id,
      'deposee',
      'emise',
      'platform',
      undefined,
    )
    await repo.recordTransition(
      t,
      id,
      'emise',
      'encaissee',
      'user:x',
      undefined,
    )
    const rows = (
      await ownerPool.query(
        "SELECT seq, encode(prev_hash,'hex') AS prev, encode(hash,'hex') AS h FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq",
        [t],
      )
    ).rows
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3])
    expect(rows[1].prev).toBe(rows[0].h) // maillon 2 → hash de 1
    expect(rows[2].prev).toBe(rows[1].h) // maillon 3 → hash de 2
  })

  it('overrides any client-supplied seq/prev_hash/hash (non-forgeable)', async () => {
    const t = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('S3') RETURNING id",
      )
    ).rows[0].id
    const inv = (
      await ownerPool.query(
        "INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical) VALUES ($1,'FA-F','380','2026-07-14','EUR','{}'::jsonb) RETURNING id",
        [t],
      )
    ).rows[0].id
    // Insertion directe (app pool) tentant de forger seq/hash → le trigger écrase.
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [t])
      await client.query(
        "INSERT INTO invoice_status_events (tenant_id, invoice_id, to_status, actor, seq, prev_hash, hash) VALUES ($1,$2,'deposee','platform', 999, '\\xdead'::bytea, '\\xbeef'::bytea)",
        [t, inv],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const r = (
      await ownerPool.query(
        "SELECT seq, encode(hash,'hex') AS h FROM invoice_status_events WHERE invoice_id = $1",
        [inv],
      )
    ).rows[0]
    expect(Number(r.seq)).toBe(1) // 999 écrasé
    expect(r.h).not.toBe('beef') // hash forgé écrasé
    expect(r.h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('serializes concurrent inserts of one tenant without forking the chain', async () => {
    const t = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('S4') RETURNING id",
      )
    ).rows[0].id
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.insertReceived(
          t,
          buildInvoice({ ...invoiceInput, number: `FA-CONC-${i}` }),
        ),
      ),
    )
    expect(ids).toHaveLength(10)
    const seqs = (
      await ownerPool.query(
        'SELECT seq FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq',
        [t],
      )
    ).rows.map((r) => Number(r.seq))
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // aucun trou, aucun doublon
  })

  it('pins search_path (pg_catalog, pg_temp) and denies EXECUTE to factelec_app on the sealing functions', async () => {
    const r = await ownerPool.query(
      `SELECT p.proname, p.proconfig,
              has_function_privilege('factelec_app', p.oid, 'EXECUTE') AS app_can_exec
         FROM pg_proc p
        WHERE p.proname IN ('ledger_field', 'seal_status_event')`,
    )
    expect(r.rows).toHaveLength(2)
    for (const row of r.rows) {
      expect(row.proconfig).toEqual(['search_path=pg_catalog, pg_temp'])
      expect(row.app_can_exec).toBe(false)
    }
  })

  it('remains APPEND-ONLY under sealing: factelec_app cannot UPDATE/DELETE (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE invoice_status_events SET hash = '\\x00'::bytea"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM invoice_status_events'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
