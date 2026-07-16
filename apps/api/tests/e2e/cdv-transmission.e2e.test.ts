import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { HttpException, INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { CdvStatusService } from '../../src/cdv/cdv-status.service.js'
import { CdvTransmissionRepository } from '../../src/cdv/cdv-transmission.repository.js'
import { CdvTransmissionService } from '../../src/cdv/cdv-transmission.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { signupSession } from './helpers/session.js'

function statusOf(err: unknown): number {
  return (err as HttpException).getStatus()
}

// `noUncheckedIndexedAccess` (tsconfig.base.json) rend un accès `arr[0]`
// possiblement `undefined` — les tests Task 8 ci-dessous récupèrent une ligne
// fraîchement créée par le test lui-même (jamais réellement absente en
// pratique) : `nth`/`first` centralisent l'assertion défensive plutôt que de
// répéter un `if (!x) throw` à chaque site d'appel.
function nth<T>(arr: T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`expected element at index ${i}`)
  return v
}
function first<T>(arr: T[]): T {
  return nth(arr, 0)
}

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
  let statusService: CdvStatusService
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
    statusService = app.get(CdvStatusService)
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

  // ── Frontière d'acquittement CDV (Task 8) : recordAck ──────────────────
  // Miroir EreportingStatusService.recordPpfStatus (2.3-T9). La SOURCE
  // réelle (push PPF / inbound réseau) est DIFFÉRÉE (D5) : `recordAck` est
  // exercée DIRECTEMENT ici, aucune route HTTP n'y accède.
  describe('frontière d’acquittement (CdvStatusService.recordAck)', () => {
    it('applique un acquittement PPF accepté (transmitted→acknowledged)', async () => {
      const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-ACK-OK')
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-ACK-OK-1',
        '900000010',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const row = first(await cdvRepo.listTransmissions(tenantId, invoiceId))
      await statusService.recordAck(tenantId, row.id, 'acknowledged', 'ppf')

      const after = await cdvRepo.findTransmission(tenantId, row.id)
      expect(after?.status).toBe('acknowledged')
      const events = await cdvRepo.listStatusEvents(tenantId, row.id)
      expect(events.map((e) => e.toStatus)).toEqual([
        'prepared',
        'transmitted',
        'acknowledged',
      ])
      expect(events.at(-1)).toMatchObject({
        fromStatus: 'transmitted',
        toStatus: 'acknowledged',
        motif: null,
        actor: 'ppf',
      })
    })

    it('applique un rejet 601 avec motif (transmitted→rejected) ; refuse un rejet sans motif (422) sans écrire d’événement', async () => {
      const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-ACK-REJ')
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-ACK-REJ-1',
        '900000011',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const row = first(await cdvRepo.listTransmissions(tenantId, invoiceId))

      let caught: unknown
      try {
        await statusService.recordAck(tenantId, row.id, 'rejected', 'ppf')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      expect(statusOf(caught)).toBe(422)
      const midEvents = await cdvRepo.listStatusEvents(tenantId, row.id)
      expect(midEvents.map((e) => e.toStatus)).toEqual([
        'prepared',
        'transmitted',
      ])

      await statusService.recordAck(
        tenantId,
        row.id,
        'rejected',
        'ppf',
        'motif-601-test',
      )
      const after = await cdvRepo.findTransmission(tenantId, row.id)
      expect(after).toMatchObject({
        status: 'rejected',
        rejectReason: 'motif-601-test',
      })
      const events = await cdvRepo.listStatusEvents(tenantId, row.id)
      expect(events.at(-1)).toMatchObject({
        fromStatus: 'transmitted',
        toStatus: 'rejected',
        motif: 'motif-601-test',
        actor: 'ppf',
      })
    })

    it('désambiguïse rejet LOCAL (actor=platform, from=null) vs 601 PPF (actor=ppf, from=transmitted)', async () => {
      const { tenantId } = await seedTenantWithKey(ownerPool, 'CDV-ACK-ORIGIN')

      // Rejet LOCAL (F6 structurellement invalide, born-rejetee — Task 6).
      const insertRow = await ownerPool.query(
        `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
         VALUES ($1, $2, '380', '2026-07-16', 'EUR', $3::jsonb) RETURNING id`,
        [
          tenantId,
          'CDV-E2E-ACK-ORIGIN-LOCAL',
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
              siren: '900000012',
              address: { countryCode: 'FR' },
            },
          }),
        ],
      )
      const localInvoiceId = insertRow.rows[0].id
      await service.transmitStatus(
        tenantId,
        localInvoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const localRow = first(
        await cdvRepo.listTransmissions(tenantId, localInvoiceId),
      )
      expect(localRow.status).toBe('rejected')
      const localEvents = await cdvRepo.listStatusEvents(tenantId, localRow.id)
      // Miroir Task 6 (`CdvTransmissionService.transmitStatus`) : le
      // born-rejet local naît TOUJOURS via la genèse `prepared` (insertTransmission,
      // fromStatus=null, actor='platform') PUIS `prepared→rejected`
      // (actor='platform') — jamais un rejet direct `null→rejected`. La
      // désambiguïsation avec un 601 réseau (`transmitted→rejected`,
      // actor='ppf'/'recipient') repose donc sur `fromStatus !== 'transmitted'`
      // ET `actor==='platform'`, jamais sur `fromStatus===null`.
      expect(localEvents.map((e) => e.toStatus)).toEqual([
        'prepared',
        'rejected',
      ])
      expect(localEvents.at(-1)).toMatchObject({
        fromStatus: 'prepared',
        toStatus: 'rejected',
        actor: 'platform',
      })

      // Rejet 601 RÉSEAU (via recordAck, from='transmitted', actor='ppf').
      const networkInvoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-ACK-ORIGIN-PPF',
        '900000013',
      )
      await service.transmitStatus(
        tenantId,
        networkInvoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const networkRow = first(
        await cdvRepo.listTransmissions(tenantId, networkInvoiceId),
      )
      await statusService.recordAck(
        tenantId,
        networkRow.id,
        'rejected',
        'ppf',
        'motif-601',
      )
      const networkEvents = await cdvRepo.listStatusEvents(
        tenantId,
        networkRow.id,
      )
      expect(networkEvents.at(-1)).toMatchObject({
        fromStatus: 'transmitted',
        toStatus: 'rejected',
        motif: 'motif-601',
        actor: 'ppf',
      })
    })

    it('refuse un acquittement sur une transmission déjà terminale (409), y compris un 601 tardif après acceptation implicite', async () => {
      const { tenantId } = await seedTenantWithKey(
        ownerPool,
        'CDV-ACK-TERMINAL',
      )
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-ACK-TERMINAL-1',
        '900000014',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const row = first(await cdvRepo.listTransmissions(tenantId, invoiceId))
      await statusService.recordAck(tenantId, row.id, 'acknowledged', 'ppf')

      // Late-601 : aucune arête acknowledged→rejected dans ALLOWED (Task 3) —
      // le CAS échoue (le prédécesseur attendu 'transmitted' ne correspond
      // plus au statut courant 'acknowledged').
      let caught: unknown
      try {
        await statusService.recordAck(
          tenantId,
          row.id,
          'rejected',
          'ppf',
          'motif-tardif',
        )
      } catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      expect(statusOf(caught)).toBe(409)

      const after = await cdvRepo.findTransmission(tenantId, row.id)
      expect(after?.status).toBe('acknowledged') // inchangé
      const events = await cdvRepo.listStatusEvents(tenantId, row.id)
      expect(events.map((e) => e.toStatus)).toEqual([
        'prepared',
        'transmitted',
        'acknowledged',
      ]) // aucun événement fantôme acknowledged→rejected
    })

    it('isole les acquittements par tenant : un id du tenant A est invisible (409) sous le tenant B, sans écrire d’événement', async () => {
      const { tenantId: tenantA } = await seedTenantWithKey(
        ownerPool,
        'CDV-ACK-RLS-A',
      )
      const { tenantId: tenantB } = await seedTenantWithKey(
        ownerPool,
        'CDV-ACK-RLS-B',
      )
      const invoiceId = await seedInvoice(
        tenantA,
        'CDV-E2E-ACK-RLS-1',
        '900000015',
      )
      await service.transmitStatus(
        tenantA,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const row = first(await cdvRepo.listTransmissions(tenantA, invoiceId))

      let caught: unknown
      try {
        await statusService.recordAck(tenantB, row.id, 'acknowledged', 'ppf')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      expect(statusOf(caught)).toBe(409)

      const after = await cdvRepo.findTransmission(tenantA, row.id)
      expect(after?.status).toBe('transmitted')
      const events = await cdvRepo.listStatusEvents(tenantA, row.id)
      expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])
    })
  })

  // ── Endpoints de consultation dual-auth (Task 8) ────────────────────────
  describe('endpoints de consultation CDV (dual-auth)', () => {
    it('liste sans XML, dgfipCode=601 seulement pour rejected (null sinon), motif exposé', async () => {
      const { tenantId, token } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-LIST',
      )
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-EP-LIST-1',
        '900000016',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'refusee',
        'ppf',
        '20260716120001',
      )
      const twoRows = await cdvRepo.listTransmissions(tenantId, invoiceId)
      const deposeeRow = nth(twoRows, 0)
      const refuseeRow = nth(twoRows, 1)
      const rejectedRow =
        deposeeRow.toStatus === 'deposee' ? deposeeRow : refuseeRow
      await statusService.recordAck(
        tenantId,
        rejectedRow.id,
        'rejected',
        'ppf',
        'motif-liste',
      )

      const res = await request(app.getHttpServer())
        .get(`/cdv/transmissions?invoiceId=${invoiceId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)

      expect(res.body.transmissions).toHaveLength(2)
      for (const item of res.body.transmissions) {
        expect(item).not.toHaveProperty('xml')
      }
      const byId = new Map(
        (
          res.body.transmissions as Array<{ id: string; [k: string]: unknown }>
        ).map((t) => [t.id, t]),
      )
      expect(byId.get(rejectedRow.id)).toMatchObject({
        status: 'rejected',
        dgfipCode: 601,
        rejectReason: 'motif-liste',
        target: 'ppf',
      })
      const otherRow =
        rejectedRow.id === deposeeRow.id ? refuseeRow : deposeeRow
      expect(byId.get(otherRow.id)).toMatchObject({
        status: 'transmitted',
        dgfipCode: null,
        rejectReason: null,
      })
    })

    it(':id/xml renvoie le F6 en text/xml ; 404 byte-identique inconnu vs autre tenant ; dual-auth clé & session', async () => {
      const { tenantId, token } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-XML',
      )
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-EP-XML-1',
        '900000017',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const row = first(await cdvRepo.listTransmissions(tenantId, invoiceId))

      const res = await request(app.getHttpServer())
        .get(`/cdv/transmissions/${row.id}/xml`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
      expect(res.headers['content-type']).toContain('text/xml')
      expect(res.text).toContain('CDV-E2E-EP-XML-1')

      const { token: otherToken } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-XML-OTHER',
      )
      const [unknown, otherTenant] = await Promise.all([
        request(app.getHttpServer())
          .get('/cdv/transmissions/00000000-0000-0000-0000-000000000000/xml')
          .set('Authorization', `Bearer ${token}`)
          .expect(404),
        request(app.getHttpServer())
          .get(`/cdv/transmissions/${row.id}/xml`)
          .set('Authorization', `Bearer ${otherToken}`)
          .expect(404),
      ])
      expect(unknown.body).toEqual(otherTenant.body)
      expect(unknown.headers['content-type']).toContain(
        'application/problem+json',
      )

      // Dual-auth : une session utilisateur (même tenant que la ressource
      // qu'elle consulte) obtient aussi 200 — pas seulement la clé API.
      const email = 'cdv-xml-session@example.com'
      const session = await signupSession(app, {
        email,
        password: 'a-strong-passphrase-123',
        organizationName: 'CDV-XML-SESSION',
        siren: null,
      })
      const sessionTenantId = (
        await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
          email,
        ])
      ).rows[0].tenant_id
      const sessionInvoiceId = await seedInvoice(
        sessionTenantId,
        'CDV-E2E-EP-XML-SESSION',
        '900000018',
      )
      await service.transmitStatus(
        sessionTenantId,
        sessionInvoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const sessionRow = first(
        await cdvRepo.listTransmissions(sessionTenantId, sessionInvoiceId),
      )
      const sessionRes = await request(app.getHttpServer())
        .get(`/cdv/transmissions/${sessionRow.id}/xml`)
        .set('Cookie', session.cookie)
        .expect(200)
      expect(sessionRes.text).toContain('CDV-E2E-EP-XML-SESSION')
    })

    it(':id/events expose actor et fromStatus (désambiguïsation), 404 anti-fuite hors-tenant', async () => {
      const { tenantId, token } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-EVENTS',
      )
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-EP-EVENTS-1',
        '900000019',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )
      const row = first(await cdvRepo.listTransmissions(tenantId, invoiceId))
      await statusService.recordAck(
        tenantId,
        row.id,
        'rejected',
        'ppf',
        'motif-events',
      )

      const res = await request(app.getHttpServer())
        .get(`/cdv/transmissions/${row.id}/events`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
      expect(
        res.body.events.map((e: { toStatus: string }) => e.toStatus),
      ).toEqual(['prepared', 'transmitted', 'rejected'])
      expect(res.body.events.at(-1)).toMatchObject({
        fromStatus: 'transmitted',
        toStatus: 'rejected',
        motif: 'motif-events',
        actor: 'ppf',
      })

      const { token: otherToken } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-EVENTS-OTHER',
      )
      await request(app.getHttpServer())
        .get(`/cdv/transmissions/${row.id}/events`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404)
    })

    it('la liste isole par tenant ; 422 si invoiceId absent ou malformé', async () => {
      const { tenantId, token } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-LIST-ISO',
      )
      const invoiceId = await seedInvoice(
        tenantId,
        'CDV-E2E-EP-LIST-ISO-1',
        '900000020',
      )
      await service.transmitStatus(
        tenantId,
        invoiceId,
        'deposee',
        'ppf',
        '20260716120000',
      )

      const { token: otherToken } = await seedTenantWithKey(
        ownerPool,
        'CDV-EP-LIST-ISO-OTHER',
      )
      const res = await request(app.getHttpServer())
        .get(`/cdv/transmissions?invoiceId=${invoiceId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200)
      expect(res.body.transmissions).toEqual([])

      await request(app.getHttpServer())
        .get('/cdv/transmissions?invoiceId=not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(422)
      await request(app.getHttpServer())
        .get('/cdv/transmissions')
        .set('Authorization', `Bearer ${token}`)
        .expect(422)
    })
  })
})
