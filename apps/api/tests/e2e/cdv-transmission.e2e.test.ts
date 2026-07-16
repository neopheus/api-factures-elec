import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { CdvTransmissionRepository } from '../../src/cdv/cdv-transmission.repository.js'
import { CdvTransmissionService } from '../../src/cdv/cdv-transmission.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Service de transmission CDV + routage annuaire (Task 6, plan 3.1) —
// tâche d'INTÉGRATION partagée avec Task 8 : boot du VRAI `AppModule`
// (`createTestApp`, port RÉEL `LocalFilesystemCdvStore` — `CDV_LOCAL_DIR`
// pointé sur un tmpdir par run, `tests/setup.ts`, leçon 2.4) contre Postgres
// réel (Testcontainers). Aucune queue/worker ici (Task 7) : `transmitStatus`
// est appelé DIRECTEMENT (motif `annuaire-publication.e2e.test.ts`,
// `directService`/instanciation via le conteneur Nest plutôt qu'une
// re-construction manuelle — récupère la VRAIE config `CDV_PA_MATRICULE`).

describe('service de transmission CDV + routage annuaire (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let service: CdvTransmissionService
  let cdvRepo: CdvTransmissionRepository
  let annuaireRepo: AnnuaireRepository
  let invoicesRepo: InvoicesRepository

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    service = app.get(CdvTransmissionService)
    cdvRepo = app.get(CdvTransmissionRepository)
    annuaireRepo = app.get(AnnuaireRepository)
    invoicesRepo = app.get(InvoicesRepository)
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  function invoiceInput(
    number: string,
    buyerSiren: string,
    overrides: Partial<InvoiceInput> = {},
  ): InvoiceInput {
    return {
      number,
      issueDate: '2026-07-16',
      typeCode: '380',
      currency: 'EUR',
      businessProcessType: 'B1',
      seller: {
        name: 'Vendeur SARL',
        siren: '111111111',
        address: { countryCode: 'FR' },
      },
      buyer: {
        name: 'Client SARL',
        siren: buyerSiren,
        address: { countryCode: 'FR' },
      },
      lines: [
        {
          id: '1',
          name: 'Bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '1000.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
      ],
      ...overrides,
    }
  }

  async function seedInvoice(
    tenantId: string,
    number: string,
    buyerSiren: string,
  ): Promise<string> {
    const { id } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput(number, buyerSiren)),
    )
    return id
  }

  it('émet un F6 vers le PPF (prepared→transmitted, XML persisté, trackingRef non nul)', async () => {
    const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-PPF')
    const invoiceId = await seedInvoice(tenantId, 'CDV-E2E-PPF-1', '900000001')

    await service.transmitStatus(
      tenantId,
      invoiceId,
      'deposee',
      'ppf',
      '20260716120000',
    )

    const rows = await ownerPool.query(
      `SELECT id, status, tracking_ref, xml, recipient_matricule
         FROM cdv_transmissions WHERE invoice_id = $1 AND target = 'ppf'`,
      [invoiceId],
    )
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]
    expect(row.status).toBe('transmitted')
    expect(row.tracking_ref).not.toBeNull()
    expect(row.xml).not.toBeNull()
    expect(row.xml).toContain('CDV-E2E-PPF-1')
    expect(row.recipient_matricule).toBeNull() // PPF : jamais résolu (D7)

    const events = await cdvRepo.listStatusEvents(tenantId, row.id)
    expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])
  })

  it("résout le destinataire via l'annuaire (miroir seedé) et émet vers la plateforme de réception", async () => {
    const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-RECIPIENT')
    const buyerSiren = '900000002'
    await annuaireRepo.upsertDirectoryEntries(tenantId, [
      {
        siren: buyerSiren,
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0042',
      },
    ])
    const invoiceId = await seedInvoice(
      tenantId,
      'CDV-E2E-RECIPIENT-1',
      buyerSiren,
    )

    await service.transmitStatus(
      tenantId,
      invoiceId,
      'deposee',
      'recipient',
      '20260716120000',
    )

    const rows = await ownerPool.query(
      `SELECT status, tracking_ref, recipient_matricule
         FROM cdv_transmissions WHERE invoice_id = $1 AND target = 'recipient'`,
      [invoiceId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      status: 'transmitted',
      recipient_matricule: '0042',
    })
    expect(rows.rows[0].tracking_ref).not.toBeNull()
  })

  it('PARKE la cible recipient si le destinataire est non adressable (parked, pas d’appel port)', async () => {
    const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-PARKED')
    // Aucune ligne d'annuaire seedée pour ce SIREN -> non adressable.
    const invoiceId = await seedInvoice(
      tenantId,
      'CDV-E2E-PARKED-1',
      '900000003',
    )

    await service.transmitStatus(
      tenantId,
      invoiceId,
      'deposee',
      'recipient',
      '20260716120000',
    )

    const rows = await ownerPool.query(
      `SELECT status, tracking_ref, xml FROM cdv_transmissions
         WHERE invoice_id = $1 AND target = 'recipient'`,
      [invoiceId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].status).toBe('parked')
    expect(rows.rows[0].tracking_ref).toBeNull()
    expect(rows.rows[0].xml).toBeNull() // résolution échouée AVANT toute génération F6

    const events = await ownerPool.query(
      `SELECT from_status, to_status, motif FROM cdv_transmission_events
         WHERE transmission_id = (
           SELECT id FROM cdv_transmissions WHERE invoice_id = $1 AND target = 'recipient'
         ) ORDER BY created_at`,
      [invoiceId],
    )
    expect(
      events.rows.map(
        (e: { from_status: string | null; to_status: string }) => [
          e.from_status,
          e.to_status,
        ],
      ),
    ).toEqual([
      [null, 'prepared'],
      ['prepared', 'parked'],
    ])
    expect(events.rows.at(-1).motif).toContain('non adressable')
  })

  it('born-rejette (rejected) un F6 structurellement invalide sans appeler le port', async () => {
    const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-INVALID')
    // Facture insérée DIRECTEMENT (bypass invoice-core, motif
    // ereporting-generation.e2e.test.ts "un XML XSD-invalide") : un
    // `canonical.number` VIDE traverse generateFlux6Cdar sans erreur (simple
    // `.txt('')`) mais produit un `<ram:IssuerAssignedID></ram:IssuerAssignedID>`
    // — structurellement invalide (MDT-87 requiert un contenu non vide,
    // `validateFlux6Structure`) — sans jamais stubber le générateur/validateur.
    const insertRow = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, $2, '380', '2026-07-16', 'EUR', $3::jsonb) RETURNING id`,
      [
        tenantId,
        'CDV-E2E-INVALID-1',
        JSON.stringify({
          number: '',
          issueDate: '2026-07-16',
          typeCode: '380',
          currency: 'EUR',
          seller: {
            name: 'V',
            siren: '111111111',
            address: { countryCode: 'FR' },
          },
          buyer: {
            name: 'A',
            siren: '900000004',
            address: { countryCode: 'FR' },
          },
        }),
      ],
    )
    const invoiceId = insertRow.rows[0].id

    await service.transmitStatus(
      tenantId,
      invoiceId,
      'deposee',
      'ppf',
      '20260716120000',
    )

    const rows = await ownerPool.query(
      `SELECT status, reject_reason, tracking_ref FROM cdv_transmissions
         WHERE invoice_id = $1 AND target = 'ppf'`,
      [invoiceId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      status: 'rejected',
      reject_reason: 'f6-invalide',
    })
    expect(rows.rows[0].tracking_ref).toBeNull()

    const events = await ownerPool.query(
      `SELECT from_status, to_status, motif FROM cdv_transmission_events
         WHERE transmission_id = (
           SELECT id FROM cdv_transmissions WHERE invoice_id = $1 AND target = 'ppf'
         ) ORDER BY created_at`,
      [invoiceId],
    )
    expect(
      events.rows.map(
        (e: { from_status: string | null; to_status: string }) => [
          e.from_status,
          e.to_status,
        ],
      ),
    ).toEqual([
      [null, 'prepared'],
      ['prepared', 'rejected'],
    ])
  })

  it('isole les transmissions par tenant (404/absence hors-tenant)', async () => {
    const { tenantId: tenantA } = await seedTenantWithKey(
      ownerPool,
      'CDV-RLS-A',
    )
    const { tenantId: tenantB } = await seedTenantWithKey(
      ownerPool,
      'CDV-RLS-B',
    )
    const invoiceId = await seedInvoice(tenantA, 'CDV-E2E-RLS-1', '900000005')

    await service.transmitStatus(
      tenantA,
      invoiceId,
      'deposee',
      'ppf',
      '20260716120000',
    )

    const asTenantA = await cdvRepo.listTransmissions(tenantA, invoiceId)
    expect(asTenantA).toHaveLength(1)

    const asTenantB = await cdvRepo.listTransmissions(tenantB, invoiceId)
    expect(asTenantB).toHaveLength(0)

    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      const r = await client.query(
        'SELECT id FROM cdv_transmissions WHERE invoice_id = $1',
        [invoiceId],
      )
      expect(r.rowCount).toBe(0)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('un rejeu (même facture/statut/cible) ne duplique ni la ligne ni les événements (idempotence)', async () => {
    const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-REPLAY')
    const invoiceId = await seedInvoice(
      tenantId,
      'CDV-E2E-REPLAY-1',
      '900000006',
    )

    await service.transmitStatus(
      tenantId,
      invoiceId,
      'deposee',
      'ppf',
      '20260716120000',
    )
    const before = await ownerPool.query(
      `SELECT id, tracking_ref FROM cdv_transmissions
         WHERE invoice_id = $1 AND target = 'ppf'`,
      [invoiceId],
    )
    expect(before.rows).toHaveLength(1)

    // Rejeu explicite : mêmes paramètres — la ligne est déjà `transmitted`
    // (skip total, D8 2e/3e couche).
    await service.transmitStatus(
      tenantId,
      invoiceId,
      'deposee',
      'ppf',
      '20260716120000',
    )

    const after = await ownerPool.query(
      `SELECT id, tracking_ref FROM cdv_transmissions
         WHERE invoice_id = $1 AND target = 'ppf'`,
      [invoiceId],
    )
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0].id).toBe(before.rows[0].id)
    expect(after.rows[0].tracking_ref).toBe(before.rows[0].tracking_ref)

    const events = await cdvRepo.listStatusEvents(tenantId, before.rows[0].id)
    expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])
  })
})
