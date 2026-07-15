import type { HttpException } from '@nestjs/common'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import {
  EreportingRepository,
  type NewTransmission,
} from '../../src/ereporting/ereporting.repository.js'
import { EreportingStatusService } from '../../src/ereporting/ereporting-status.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Acquittements PPF 300/301 (Task 9, plan 2.3) — frontière D7 : la SOURCE
// réelle (push/poll PPF) est différée à un futur adaptateur, EreportingStatusService
// .recordPpfStatus est exercée DIRECTEMENT ici (aucune route HTTP dans cette
// tâche), Postgres réel (Testcontainers), style identique à
// ereporting-persistence.e2e.test.ts (Task 5).

const transmission = (
  declarantId: string,
  overrides: Partial<NewTransmission> = {},
): NewTransmission => ({
  declarantId,
  transmissionRef: 'TT-STATUS-1',
  type: 'IN',
  fluxKind: 'transactions',
  periodStart: '20260701',
  periodEnd: '20260731',
  invoiceCount: 0,
  xml: '<Report/>',
  ...overrides,
})

function statusOf(err: unknown): number {
  return (err as HttpException).getStatus()
}

describe('e-reporting PPF acknowledgement service (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: EreportingRepository
  let service: EreportingStatusService
  let tenantA: string
  let tenantB: string
  let declarantA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new EreportingRepository(new TenantContextService(appPool))
    service = new EreportingStatusService(repo)
    tenantA = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('EREP-STATUS-A') RETURNING id",
      )
    ).rows[0].id
    tenantB = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('EREP-STATUS-B') RETURNING id",
      )
    ).rows[0].id
    declarantA = (
      await ownerPool.query(
        `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
         VALUES ($1, '111222333', 'Déclarant Status', 'SE', 'simplifie') RETURNING id`,
        [tenantA],
      )
    ).rows[0].id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  // Insère + transmet (prepared -> transmitted) une transmission fraîche,
  // renvoie son id — état de départ standard pour l'acquittement. `periodStart`
  // DOIT être distinct entre appels : l'index unique partiel (déclarant,
  // flux_kind, period_start) WHERE type='IN' (Task 5, amendement A2)
  // idempotent réutiliserait sinon la MÊME ligne entre tests (même déclarant,
  // même flux, même période) — ce n'est PAS un test d'idempotence ici, chaque
  // test a besoin de SA PROPRE transmission fraîche.
  async function seedTransmitted(
    ref: string,
    periodStart: string,
  ): Promise<string> {
    const { id } = await repo.insertTransmission(
      tenantA,
      transmission(declarantA, {
        transmissionRef: ref,
        periodStart,
        periodEnd: periodStart,
      }),
    )
    await repo.markTransmitted(tenantA, id, `TRACK-${ref}`)
    return id
  }

  it('applique un acquittement 300 (déposée) : transmitted→deposee', async () => {
    const id = await seedTransmitted('TT-300', '20260701')
    await service.recordPpfStatus(tenantA, id, 'deposee')

    const row = await ownerPool.query(
      'SELECT status FROM ereporting_transmissions WHERE id = $1',
      [id],
    )
    expect(row.rows[0].status).toBe('deposee')

    const events = await repo.listStatusEvents(tenantA, id)
    expect(events.map((e) => e.toStatus)).toEqual([
      'prepared',
      'transmitted',
      'deposee',
    ])
    expect(events.at(-1)).toMatchObject({
      fromStatus: 'transmitted',
      toStatus: 'deposee',
      motif: null,
      actor: 'ppf',
    })
  })

  it('applique un rejet 301 avec motif REJ_SEMAN : transmitted→rejetee', async () => {
    const id = await seedTransmitted('TT-301', '20260702')
    await service.recordPpfStatus(tenantA, id, 'rejetee', 'REJ_SEMAN')

    const events = await repo.listStatusEvents(tenantA, id)
    expect(events.at(-1)).toMatchObject({
      fromStatus: 'transmitted',
      toStatus: 'rejetee',
      motif: 'REJ_SEMAN',
      actor: 'ppf',
    })
  })

  it('refuse un rejet 301 SANS motif (422), sans écrire d’événement', async () => {
    const id = await seedTransmitted('TT-301-NOMOTIF', '20260703')

    let caught: unknown
    try {
      await service.recordPpfStatus(tenantA, id, 'rejetee')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(statusOf(caught)).toBe(422)

    // Aucun événement supplémentaire : seuls les 2 événements de genèse
    // (prepared, transmitted) subsistent — le motif manquant est détecté
    // AVANT toute transaction CAS.
    const events = await repo.listStatusEvents(tenantA, id)
    expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])

    const row = await ownerPool.query(
      'SELECT status FROM ereporting_transmissions WHERE id = $1',
      [id],
    )
    expect(row.rows[0].status).toBe('transmitted')
  })

  it('refuse une transition invalide depuis un statut terminal (409), sans écrire d’événement (CAS atomique)', async () => {
    const id = await seedTransmitted('TT-TERMINAL', '20260704')
    await service.recordPpfStatus(tenantA, id, 'deposee')

    let caught: unknown
    try {
      // 'deposee' est TERMINAL : un second acquittement (même 300, ou 301)
      // doit être refusé — le prédécesseur attendu ('transmitted') ne
      // correspond plus au statut courant.
      await service.recordPpfStatus(tenantA, id, 'deposee')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(statusOf(caught)).toBe(409)

    const events = await repo.listStatusEvents(tenantA, id)
    expect(events.map((e) => e.toStatus)).toEqual([
      'prepared',
      'transmitted',
      'deposee',
    ])
  })

  it('refuse un acquittement PPF sur une transmission née rejetée localement (REJ_SEMAN, born-rejetee)', async () => {
    // insertTransmission avec rejectMotif : la ligne naît DIRECTEMENT
    // `rejetee` (fromStatus=null, actor='platform') — jamais `transmitted`,
    // donc jamais transmise réellement au PPF (injection T8 revue #6).
    const { id } = await repo.insertTransmission(
      tenantA,
      transmission(declarantA, {
        transmissionRef: 'TT-BORN-REJ',
        periodStart: '20260705',
        periodEnd: '20260705',
        rejectMotif: 'REJ_SEMAN',
      }),
    )

    let caught: unknown
    try {
      await service.recordPpfStatus(tenantA, id, 'deposee')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(statusOf(caught)).toBe(409)

    const events = await repo.listStatusEvents(tenantA, id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'rejetee',
      motif: 'REJ_SEMAN',
      actor: 'platform',
    })

    const row = await ownerPool.query(
      'SELECT status FROM ereporting_transmissions WHERE id = $1',
      [id],
    )
    expect(row.rows[0].status).toBe('rejetee')
  })

  it('isole les acquittements par tenant : un id du tenant A est invisible (409) sous le tenant B, sans écrire d’événement', async () => {
    const id = await seedTransmitted('TT-ISOLATION', '20260706')

    let caught: unknown
    try {
      await service.recordPpfStatus(tenantB, id, 'deposee')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(statusOf(caught)).toBe(409)

    // Le tenant A n'a subi AUCUNE mutation : toujours `transmitted`, 2
    // événements seulement (aucun acquittement fantôme cross-tenant).
    const row = await ownerPool.query(
      'SELECT status FROM ereporting_transmissions WHERE id = $1',
      [id],
    )
    expect(row.rows[0].status).toBe('transmitted')
    const events = await repo.listStatusEvents(tenantA, id)
    expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])
  })
})
