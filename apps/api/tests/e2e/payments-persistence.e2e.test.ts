import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import type { PaymentCapture } from '../../src/payments/payment.model.js'
import { PaymentsRepository } from '../../src/payments/payments.repository.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Persistance des encaissements (Task 4, plan 3.2) : capture EXPLICITE (D5,
// pas d'auto-seed depuis 212) sous RLS FORCE + grants SELECT,INSERT
// seulement (immutabilité après capture), idempotence de capture par
// (invoice_id, reference), FK invoice RESTRICT. Style e2e identique aux
// persistances CDV/e-reporting (3.1/2.3) : Postgres réel via Testcontainers,
// pools owner (BYPASSRLS, fixtures) et app (factelec_app, moindre privilège).

const payment = (
  invoiceId: string,
  overrides: Partial<PaymentCapture> = {},
): PaymentCapture => ({
  invoiceId,
  paymentDate: '20260716',
  currency: 'EUR',
  reference: 'REF-1',
  subtotals: [{ taxPercent: '20.00', amount: '120.00' }],
  ...overrides,
})

describe('Payments persistence (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: PaymentsRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    // pg recommande TOUJOURS un écouteur `error` sur un Pool (cf. 2.2/2.3/2.4/3.1) :
    // sans lui, une erreur sur un client IDLE (bruit 57P01 au teardown du
    // conteneur) est relancée et fait planter le process — gate rouge
    // intermittente.
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new PaymentsRepository(new TenantContextService(appPool))
    tenantA = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('PAY-A') RETURNING id",
      )
    ).rows[0].id
    tenantB = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('PAY-B') RETURNING id",
      )
    ).rows[0].id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  const insertInvoice = async (
    tenantId: string,
    number: string,
  ): Promise<string> =>
    (
      await ownerPool.query(
        `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
         VALUES ($1, $2, '380', '2026-07-16', 'EUR', '{}'::jsonb) RETURNING id`,
        [tenantId, number],
      )
    ).rows[0].id

  // ── RLS FORCE : isolation des encaissements et de leurs sous-totaux ──────

  it('isole les encaissements par tenant (RLS FORCE, sous-totaux compris)', async () => {
    const invoiceId = await insertInvoice(tenantA, 'PAY-ISO-1')
    const { id } = await repo.insertPayment(
      tenantA,
      payment(invoiceId, { reference: 'PAY-ISO-1-REF' }),
    )

    const asB = await appPool.connect()
    try {
      await asB.query('BEGIN')
      await asB.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      const rPayment = await asB.query(
        'SELECT id FROM payments WHERE id = $1',
        [id],
      )
      expect(rPayment.rowCount).toBe(0)
      const rSubtotals = await asB.query(
        'SELECT id FROM payment_subtotals WHERE payment_id = $1',
        [id],
      )
      expect(rSubtotals.rowCount).toBe(0)
      await asB.query('ROLLBACK')
    } finally {
      asB.release()
    }

    const asA = await appPool.connect()
    try {
      await asA.query('BEGIN')
      await asA.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      const rPayment = await asA.query(
        'SELECT id FROM payments WHERE id = $1',
        [id],
      )
      expect(rPayment.rowCount).toBe(1)
      const rSubtotals = await asA.query(
        'SELECT id FROM payment_subtotals WHERE payment_id = $1',
        [id],
      )
      expect(rSubtotals.rowCount).toBe(1)
      await asA.query('COMMIT')
    } finally {
      asA.release()
    }
  })

  it('interdit INSERT dans un autre tenant (WITH CHECK)', async () => {
    const invoiceId = await insertInvoice(tenantA, 'PAY-ISO-2')
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      await expect(
        client.query(
          `INSERT INTO payments (tenant_id, invoice_id, payment_date, reference)
           VALUES ($1, $2, '20260716', 'X')`,
          [tenantA, invoiceId],
        ),
      ).rejects.toThrow(/row-level security/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // ── Moindre privilège : immutabilité après capture ───────────────────────

  it('interdit UPDATE/DELETE sur payments et payment_subtotals (42501, immutables après capture)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE payments SET reference = 'x'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(client.query('DELETE FROM payments')).rejects.toMatchObject({
        code: '42501',
      })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE payment_subtotals SET amount = '0.00'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM payment_subtotals'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // ── FK RESTRICT ───────────────────────────────────────────────────────────

  it('bloque la suppression d’une facture munie d’un encaissement (23503)', async () => {
    const invoiceId = await insertInvoice(tenantA, 'PAY-FK-1')
    await repo.insertPayment(
      tenantA,
      payment(invoiceId, { reference: 'FK-REF' }),
    )
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it("autorise la suppression d'une facture SANS encaissement (asymétrie RESTRICT)", async () => {
    const invoiceId = await insertInvoice(tenantA, 'PAY-FK-2')
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  // ── Idempotence de capture (D5) ───────────────────────────────────────────

  describe('D5 — idempotence de capture insertPayment', () => {
    it('2e insertPayment (invoice, reference) → created:false, 0 doublon de sous-total, valeurs d’origine conservées', async () => {
      const invoiceId = await insertInvoice(tenantA, 'PAY-IDEM-1')
      const first = await repo.insertPayment(
        tenantA,
        payment(invoiceId, { reference: 'IDEM-REF' }),
      )
      expect(first.created).toBe(true)

      const second = await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'IDEM-REF',
          subtotals: [{ taxPercent: '5.50', amount: '999.99' }],
        }),
      )
      expect(second.created).toBe(false)
      expect(second.id).toBe(first.id)

      const rows = await ownerPool.query(
        `SELECT count(*)::int AS n FROM payments
         WHERE invoice_id = $1 AND reference = 'IDEM-REF'`,
        [invoiceId],
      )
      expect(rows.rows[0].n).toBe(1)

      // Le 2e appel (idempotent, created:false) N'A PAS écrit de second
      // sous-total — les valeurs d'origine (1ère capture) restent seules en base.
      const subtotals = await ownerPool.query(
        'SELECT tax_percent, amount FROM payment_subtotals WHERE payment_id = $1',
        [first.id],
      )
      expect(subtotals.rows).toHaveLength(1)
      expect(subtotals.rows[0]).toMatchObject({
        tax_percent: '20.00',
        amount: '120.00',
      })
    })

    it('une même facture accepte des références DISTINCTES (le slot ne couvre QUE (invoice, reference))', async () => {
      const invoiceId = await insertInvoice(tenantA, 'PAY-IDEM-2')
      const refA = await repo.insertPayment(
        tenantA,
        payment(invoiceId, { reference: 'IDEM-2-A' }),
      )
      const refB = await repo.insertPayment(
        tenantA,
        payment(invoiceId, { reference: 'IDEM-2-B' }),
      )
      expect(refA.created).toBe(true)
      expect(refB.created).toBe(true)
      expect(refA.id).not.toBe(refB.id)
    })
  })

  // ── Repository : lectures ─────────────────────────────────────────────────

  describe('PaymentsRepository — lectures', () => {
    it('listPayments : contenu et filtrage par facture', async () => {
      const invoiceId = await insertInvoice(tenantA, 'PAY-READ-1')
      const other = await insertInvoice(tenantA, 'PAY-READ-2')
      await repo.insertPayment(
        tenantA,
        payment(invoiceId, { reference: 'READ-1' }),
      )
      await repo.insertPayment(
        tenantA,
        payment(other, { reference: 'READ-OTHER' }),
      )

      const list = await repo.listPayments(tenantA, invoiceId)
      expect(list).toHaveLength(1)
      const [row] = list
      expect(row).toMatchObject({
        invoiceId,
        reference: 'READ-1',
        currency: 'EUR',
        paymentDate: '20260716',
      })
      expect(row?.subtotals).toEqual([
        { taxPercent: '20.00', amount: '120.00' },
      ])

      expect(
        await repo.listPayments(
          tenantA,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).toEqual([])
    })

    it('sumCapturedByRate : additionne exactement 2 paiements partiels sur 2 taux', async () => {
      const invoiceId = await insertInvoice(tenantA, 'PAY-SUM-1')
      await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'SUM-1',
          subtotals: [
            { taxPercent: '20.00', amount: '60.00' },
            { taxPercent: '5.50', amount: '10.55' },
          ],
        }),
      )
      await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'SUM-2',
          subtotals: [
            { taxPercent: '20.00', amount: '40.00' },
            { taxPercent: '5.50', amount: '4.45' },
          ],
        }),
      )

      const sums = await repo.sumCapturedByRate(tenantA, invoiceId)
      expect(sums).toHaveLength(2)
      expect(sums).toEqual(
        expect.arrayContaining([
          { taxPercent: '20.00', amount: '100.00' },
          { taxPercent: '5.50', amount: '15.00' },
        ]),
      )

      expect(
        await repo.sumCapturedByRate(
          tenantA,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).toEqual([])
    })

    it('listPaymentsForPeriod : bornes AAAAMMJJ inclusives (paiement au bord inclus, hors-borne exclu)', async () => {
      const invoiceId = await insertInvoice(tenantA, 'PAY-PERIOD-1')
      const before = await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'PERIOD-BEFORE',
          paymentDate: '20260630',
        }),
      )
      const atStart = await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'PERIOD-START',
          paymentDate: '20260701',
        }),
      )
      const atEnd = await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'PERIOD-END',
          paymentDate: '20260731',
        }),
      )
      const after = await repo.insertPayment(
        tenantA,
        payment(invoiceId, {
          reference: 'PERIOD-AFTER',
          paymentDate: '20260801',
        }),
      )

      const rows = await repo.listPaymentsForPeriod(
        tenantA,
        '20260701',
        '20260731',
      )
      const ids = rows.map((r) => r.id)
      expect(ids).toContain(atStart.id)
      expect(ids).toContain(atEnd.id)
      expect(ids).not.toContain(before.id)
      expect(ids).not.toContain(after.id)

      const found = rows.find((r) => r.id === atStart.id)
      expect(found?.subtotals).toEqual([
        { taxPercent: '20.00', amount: '120.00' },
      ])

      expect(
        await repo.listPaymentsForPeriod(tenantA, '19990101', '19990102'),
      ).toEqual([])
    })
  })
})
