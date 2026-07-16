import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CdvTransmissionRepository,
  type NewCdvTransmission,
} from '../../src/cdv/cdv-transmission.repository.js'
import { InvalidCdvTransmissionTransitionError } from '../../src/cdv/cdv-transmission-lifecycle.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Persistance des transmissions CDV (Task 4, plan 3.1) : suivi de livraison +
// journal append-only sous RLS FORCE + moindre privilège différencié, SD
// cross-tenant find_cdv_transmissions_due (lecture seule du journal SCELLÉ
// invoice_status_events, 2.2), et backstop D8 (index unique
// invoice×statut×cible). Style e2e identique à ereporting/annuaire
// persistence (2.3/2.4) : Postgres réel via Testcontainers, pools owner
// (BYPASSRLS, migrations/fixtures) et app (factelec_app, moindre privilège).

const transmission = (
  invoiceId: string,
  overrides: Partial<NewCdvTransmission> = {},
): NewCdvTransmission => ({
  invoiceId,
  toStatus: 'deposee',
  target: 'ppf',
  statusHorodate: '20260716120000',
  xml: null,
  recipientMatricule: null,
  ...overrides,
})

describe('CDV transmission persistence (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: CdvTransmissionRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    // pg recommande TOUJOURS un écouteur `error` sur un Pool (cf. 2.2/2.3/2.4) :
    // sans lui, une erreur sur un client IDLE (bruit 57P01 au teardown du
    // conteneur) est relancée et fait planter le process — gate rouge
    // intermittente.
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new CdvTransmissionRepository(new TenantContextService(appPool))
    tenantA = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('CDV-A') RETURNING id",
      )
    ).rows[0].id
    tenantB = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('CDV-B') RETURNING id",
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

  const insertStatusEvent = async (
    tenantId: string,
    invoiceId: string,
    toStatus: string,
    createdAt: Date,
  ): Promise<void> => {
    await ownerPool.query(
      `INSERT INTO invoice_status_events (tenant_id, invoice_id, from_status, to_status, actor, created_at)
       VALUES ($1, $2, NULL, $3, 'platform', $4)`,
      [tenantId, invoiceId, toStatus, createdAt],
    )
  }

  // ── RLS FORCE : isolation des transmissions et du journal ────────────────

  it('isole les transmissions/journal par tenant (RLS FORCE)', async () => {
    const invoiceId = await insertInvoice(tenantA, 'CDV-ISO-1')
    const { id } = await repo.insertTransmission(
      tenantA,
      transmission(invoiceId, { toStatus: 'deposee', target: 'ppf' }),
    )

    const asB = await appPool.connect()
    try {
      await asB.query('BEGIN')
      await asB.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      const rTransmission = await asB.query(
        'SELECT id FROM cdv_transmissions WHERE id = $1',
        [id],
      )
      expect(rTransmission.rowCount).toBe(0)
      const rEvents = await asB.query(
        'SELECT id FROM cdv_transmission_events WHERE transmission_id = $1',
        [id],
      )
      expect(rEvents.rowCount).toBe(0)
      await asB.query('ROLLBACK')
    } finally {
      asB.release()
    }

    const asA = await appPool.connect()
    try {
      await asA.query('BEGIN')
      await asA.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      const rTransmission = await asA.query(
        'SELECT id FROM cdv_transmissions WHERE id = $1',
        [id],
      )
      expect(rTransmission.rowCount).toBe(1)
      const rEvents = await asA.query(
        'SELECT id FROM cdv_transmission_events WHERE transmission_id = $1',
        [id],
      )
      expect(rEvents.rowCount).toBe(1)
      await asA.query('COMMIT')
    } finally {
      asA.release()
    }
  })

  it('interdit INSERT dans un autre tenant (WITH CHECK)', async () => {
    const invoiceId = await insertInvoice(tenantA, 'CDV-ISO-2')
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      await expect(
        client.query(
          `INSERT INTO cdv_transmissions (tenant_id, invoice_id, to_status, target, status_horodate)
           VALUES ($1, $2, 'deposee', 'ppf', '20260716120000')`,
          [tenantA, invoiceId],
        ),
      ).rejects.toThrow(/row-level security/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // ── Moindre privilège : journal append-only ──────────────────────────────

  it('interdit UPDATE/DELETE sur le journal CDV (42501, append-only)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE cdv_transmission_events SET actor = 'x'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM cdv_transmission_events'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('interdit DELETE sur les transmissions pour factelec_app (42501, pas de DELETE dans les grants)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM cdv_transmissions'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // ── SD cross-tenant find_cdv_transmissions_due ───────────────────────────

  it('find_cdv_transmissions_due voit les statuts obligatoires de tous les tenants dans la fenêtre bornée, exclut les facultatifs et le hors-fenêtre, search_path épinglé, EXECUTE accordé à factelec_app', async () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 60_000) // 1 min : dans la fenêtre
    const stale = new Date(now.getTime() - 3 * 24 * 3_600_000) // 3 jours : hors fenêtre
    const pSince = new Date(now.getTime() - 24 * 3_600_000) // fenêtre 24h

    const invA = await insertInvoice(tenantA, 'CDV-SD-A')
    const invB = await insertInvoice(tenantB, 'CDV-SD-B')
    const invAFacultatif = await insertInvoice(tenantA, 'CDV-SD-A-FAC')
    const invAStale = await insertInvoice(tenantA, 'CDV-SD-A-STALE')

    await insertStatusEvent(tenantA, invA, 'deposee', recent) // obligatoire, tenant A, dans la fenêtre
    await insertStatusEvent(tenantB, invB, 'encaissee', recent) // obligatoire, tenant B, dans la fenêtre
    await insertStatusEvent(
      tenantA,
      invAFacultatif,
      'mise_a_disposition',
      recent,
    ) // FACULTATIF — exclu quelle que soit la fenêtre (D7)
    await insertStatusEvent(tenantA, invAStale, 'refusee', stale) // obligatoire mais HORS fenêtre (D8)

    const client = await appPool.connect()
    let rows: {
      tenant_id: string
      invoice_id: string
      to_status: string
    }[]
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      rows = (
        await client.query('SELECT * FROM find_cdv_transmissions_due($1)', [
          pSince,
        ])
      ).rows
      await client.query('COMMIT')
    } finally {
      client.release()
    }

    const invoiceIds = rows.map((r) => r.invoice_id)
    expect(invoiceIds).toContain(invA)
    expect(invoiceIds).toContain(invB)
    expect(invoiceIds).not.toContain(invAFacultatif)
    expect(invoiceIds).not.toContain(invAStale)
    expect(rows.some((r) => r.tenant_id === tenantA)).toBe(true)
    expect(rows.some((r) => r.tenant_id === tenantB)).toBe(true)
    expect(rows.find((r) => r.invoice_id === invA)?.to_status).toBe('deposee')
    expect(rows.find((r) => r.invoice_id === invB)?.to_status).toBe('encaissee')

    const meta = await ownerPool.query(
      `SELECT p.proconfig, has_function_privilege('factelec_app', p.oid, 'EXECUTE') AS app_can_exec
         FROM pg_proc p WHERE p.proname = 'find_cdv_transmissions_due'`,
    )
    expect(meta.rows).toHaveLength(1)
    expect(meta.rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp'])
    expect(meta.rows[0].app_can_exec).toBe(true)
  })

  // ── FK RESTRICT ───────────────────────────────────────────────────────────

  it('bloque la suppression d’une facture munie d’une transmission (23503)', async () => {
    const invoiceId = await insertInvoice(tenantA, 'CDV-FK-1')
    await repo.insertTransmission(
      tenantA,
      transmission(invoiceId, { toStatus: 'deposee', target: 'ppf' }),
    )
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it("autorise la suppression d'une facture SANS transmission (asymétrie RESTRICT)", async () => {
    const invoiceId = await insertInvoice(tenantA, 'CDV-FK-2')
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  // ── D8 : idempotence de slot (invoice, to_status, target) ────────────────

  describe('D8 — idempotence de slot insertTransmission', () => {
    it('deux insertTransmission identiques (facture, statut, cible) → 1 seule ligne, 2e appel created:false, 0 doublon d’événement', async () => {
      const invoiceId = await insertInvoice(tenantA, 'CDV-IDEM-1')
      const first = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'ppf' }),
      )
      expect(first.created).toBe(true)

      const second = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'ppf' }),
      )
      expect(second.created).toBe(false)
      expect(second.id).toBe(first.id)

      const rows = await ownerPool.query(
        `SELECT count(*)::int AS n FROM cdv_transmissions
         WHERE invoice_id = $1 AND to_status = 'deposee' AND target = 'ppf'`,
        [invoiceId],
      )
      expect(rows.rows[0].n).toBe(1)

      // Le 2e appel (idempotent, created:false) N'A PAS écrit de second
      // événement genèse — un seul `prepared` pour la ligne unique.
      const events = await repo.listStatusEvents(tenantA, first.id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'prepared',
        actor: 'platform',
      })
    })

    it('une même facture accepte des lignes DISTINCTES par statut et par cible (le slot ne couvre QUE (facture,statut,cible))', async () => {
      const invoiceId = await insertInvoice(tenantA, 'CDV-IDEM-2')
      const depositPpf = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'ppf' }),
      )
      const depositRecipient = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'recipient' }),
      )
      const rejectedPpf = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'rejetee', target: 'ppf' }),
      )
      expect(depositPpf.created).toBe(true)
      expect(depositRecipient.created).toBe(true)
      expect(rejectedPpf.created).toBe(true)
      expect(
        new Set([depositPpf.id, depositRecipient.id, rejectedPpf.id]).size,
      ).toBe(3)
    })
  })

  // ── Repository : transitions du cycle de vie ─────────────────────────────

  describe('CdvTransmissionRepository — transitions', () => {
    it('markTransmitted : prepared→transmitted (trackingRef + journal), rejette une transition périmée', async () => {
      const invoiceId = await insertInvoice(tenantA, 'CDV-TR-1')
      const { id } = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'ppf' }),
      )

      await repo.markTransmitted(tenantA, id, 'TRACK-1')

      const row = await ownerPool.query(
        'SELECT status, tracking_ref FROM cdv_transmissions WHERE id = $1',
        [id],
      )
      expect(row.rows[0]).toMatchObject({
        status: 'transmitted',
        tracking_ref: 'TRACK-1',
      })
      const events = await repo.listStatusEvents(tenantA, id)
      expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])

      // Rejouer markTransmitted (déjà `transmitted`, plus `prepared`/`parked`) :
      // CAS périmé → rejet, aucun événement supplémentaire.
      await expect(
        repo.markTransmitted(tenantA, id, 'TRACK-2'),
      ).rejects.toThrow(/not in 'prepared' or 'parked' status/)
      expect(await repo.listStatusEvents(tenantA, id)).toHaveLength(2)
    })

    it('markParked puis markTransmitted : prepared→parked→transmitted (reprise T7)', async () => {
      const invoiceId = await insertInvoice(tenantA, 'CDV-TR-2')
      const { id } = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'recipient' }),
      )

      await repo.markParked(tenantA, id, 'destinataire non adressable')
      expect(
        (
          await ownerPool.query(
            'SELECT status FROM cdv_transmissions WHERE id = $1',
            [id],
          )
        ).rows[0].status,
      ).toBe('parked')

      // Reprise : parked→transmitted, autorisée par la machine (Task 3).
      await repo.markTransmitted(tenantA, id, 'TRACK-RESUME')
      expect(
        (
          await ownerPool.query(
            'SELECT status FROM cdv_transmissions WHERE id = $1',
            [id],
          )
        ).rows[0].status,
      ).toBe('transmitted')

      const events = await repo.listStatusEvents(tenantA, id)
      expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        'null->prepared', // premier événement genèse (fromStatus=null)
        'prepared->parked',
        'parked->transmitted',
      ])

      // markParked rejette une transition périmée (déjà transmitted, plus prepared).
      await expect(repo.markParked(tenantA, id, 'x')).rejects.toThrow(
        /not in 'prepared' status/,
      )
    })

    it('appendStatusEvent : transmitted→acknowledged sans motif, exige un motif pour →rejected (persisté en reject_reason), rejette une transition invalide et une transition périmée', async () => {
      const invoiceAck = await insertInvoice(tenantA, 'CDV-TR-ACK')
      const { id: idAck } = await repo.insertTransmission(
        tenantA,
        transmission(invoiceAck, { toStatus: 'deposee', target: 'ppf' }),
      )
      await repo.markTransmitted(tenantA, idAck, 'TRACK-ACK')
      await repo.appendStatusEvent(
        tenantA,
        idAck,
        'transmitted',
        'acknowledged',
        'ppf',
      )
      expect(
        (
          await ownerPool.query(
            'SELECT status FROM cdv_transmissions WHERE id = $1',
            [idAck],
          )
        ).rows[0].status,
      ).toBe('acknowledged')

      // acknowledged est TERMINAL (Task 3) : toute nouvelle transition est invalide.
      await expect(
        repo.appendStatusEvent(
          tenantA,
          idAck,
          'acknowledged',
          'rejected',
          'ppf',
          'x',
        ),
      ).rejects.toBeInstanceOf(InvalidCdvTransmissionTransitionError)

      const invoiceRej = await insertInvoice(tenantA, 'CDV-TR-REJ')
      const { id: idRej } = await repo.insertTransmission(
        tenantA,
        transmission(invoiceRej, { toStatus: 'rejetee', target: 'ppf' }),
      )
      await repo.markTransmitted(tenantA, idRej, 'TRACK-REJ')

      await expect(
        repo.appendStatusEvent(
          tenantA,
          idRej,
          'transmitted',
          'rejected',
          'ppf',
        ),
      ).rejects.toThrow(/motif is required/)

      await repo.appendStatusEvent(
        tenantA,
        idRej,
        'transmitted',
        'rejected',
        'ppf',
        'Message CDV rejeté par le PPF (601)',
      )
      const row = await ownerPool.query(
        'SELECT status, reject_reason FROM cdv_transmissions WHERE id = $1',
        [idRej],
      )
      expect(row.rows[0]).toMatchObject({
        status: 'rejected',
        reject_reason: 'Message CDV rejeté par le PPF (601)',
      })
      const events = await repo.listStatusEvents(tenantA, idRej)
      expect(events.at(-1)).toMatchObject({
        fromStatus: 'transmitted',
        toStatus: 'rejected',
        motif: 'Message CDV rejeté par le PPF (601)',
        actor: 'ppf',
      })

      // CAS périmé : la transmission n'est plus `transmitted`.
      await expect(
        repo.appendStatusEvent(
          tenantA,
          idRej,
          'transmitted',
          'rejected',
          'ppf',
          'x',
        ),
      ).rejects.toThrow(/not in 'transmitted' status/)
    })
  })

  // ── Repository : lectures & reprise ───────────────────────────────────────

  describe('CdvTransmissionRepository — lectures', () => {
    it('findTransmission, listTransmissions : contenu et filtrage par facture', async () => {
      const invoiceId = await insertInvoice(tenantA, 'CDV-READ-1')
      const { id } = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, {
          toStatus: 'deposee',
          target: 'ppf',
          xml: '<CDAR/>',
        }),
      )

      const found = await repo.findTransmission(tenantA, id)
      expect(found).toMatchObject({
        id,
        invoiceId,
        toStatus: 'deposee',
        target: 'ppf',
        status: 'prepared',
        xml: '<CDAR/>',
      })

      const list = await repo.listTransmissions(tenantA, invoiceId)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id })

      expect(
        await repo.findTransmission(
          tenantA,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).toBeNull()
    })

    it('findResumable : resumable=true tant que non terminal (parked), resumable=false une fois terminal (acknowledged/rejected), null si inconnu', async () => {
      const invoiceId = await insertInvoice(tenantA, 'CDV-RESUME-1')
      const { id } = await repo.insertTransmission(
        tenantA,
        transmission(invoiceId, { toStatus: 'deposee', target: 'recipient' }),
      )
      await repo.markParked(tenantA, id, 'non adressable')

      const parked = await repo.findResumable(
        tenantA,
        invoiceId,
        'deposee',
        'recipient',
      )
      expect(parked).toMatchObject({ id, status: 'parked', resumable: true })

      await repo.markTransmitted(tenantA, id, 'TRACK-RESUMABLE')
      await repo.appendStatusEvent(
        tenantA,
        id,
        'transmitted',
        'acknowledged',
        'ppf',
      )
      const terminal = await repo.findResumable(
        tenantA,
        invoiceId,
        'deposee',
        'recipient',
      )
      expect(terminal).toMatchObject({
        id,
        status: 'acknowledged',
        resumable: false,
      })

      expect(
        await repo.findResumable(
          tenantA,
          '00000000-0000-0000-0000-000000000000',
          'deposee',
          'ppf',
        ),
      ).toBeNull()
    })
  })
})
