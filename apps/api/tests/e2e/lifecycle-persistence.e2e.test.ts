import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const invoiceInput: InvoiceInput = {
  number: 'FA-LC-1',
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
      name: 'S',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

describe('invoice_status_events persistence (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    const a = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('A') RETURNING id",
    )
    tenantA = a.rows[0].id
    const b = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('B') RETURNING id",
    )
    tenantB = b.rows[0].id
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('insertReceived writes the invoice at lifecycle deposee + an initial event', async () => {
    const { id } = await repo.insertReceived(
      tenantA,
      buildInvoice(invoiceInput),
    )
    const inv = await ownerPool.query(
      'SELECT lifecycle_status FROM invoices WHERE id = $1',
      [id],
    )
    expect(inv.rows[0].lifecycle_status).toBe('deposee')
    const ev = await ownerPool.query(
      'SELECT from_status, to_status, actor FROM invoice_status_events WHERE invoice_id = $1',
      [id],
    )
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0]).toMatchObject({
      from_status: null,
      to_status: 'deposee',
      actor: 'platform',
    })
  })

  it('isolates events per tenant (RLS)', async () => {
    const { id } = await repo.insertReceived(
      tenantB,
      buildInvoice({ ...invoiceInput, number: 'FA-LC-B' }),
    )
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      const foreign = await client.query(
        'SELECT id FROM invoice_status_events WHERE invoice_id = $1',
        [id],
      )
      expect(foreign.rowCount).toBe(0) // événement de B invisible sous contexte A
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  // Deux transactions distinctes (et non deux requêtes dans la même
  // transaction, comme dans le brief) : après une erreur SQL (42501,
  // permission denied), Postgres passe la transaction en cours dans l'état
  // "aborted" — toute requête suivante y échoue avec 25P02 ("current
  // transaction is aborted"), pas avec le code de l'erreur qu'on veut
  // vérifier. Confirmé empiriquement en exécutant le code du brief tel
  // quel (RED sur la 2e assertion). Chaque vérification a donc besoin de
  // son propre BEGIN/ROLLBACK (avec re-pose du contexte tenant, `true` =
  // portée transaction) pour observer indépendamment le 42501 de l'UPDATE
  // et celui du DELETE.
  it('is APPEND-ONLY: factelec_app cannot UPDATE or DELETE events (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE invoice_status_events SET actor = 'tampered'"),
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

  it('keeps factelec_app NOBYPASSRLS / NOSUPERUSER', async () => {
    const r = await appPool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  })
})
