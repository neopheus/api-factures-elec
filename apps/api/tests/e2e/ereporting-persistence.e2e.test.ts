import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CasStaleError } from '../../src/common/cas-error.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import {
  EreportingRepository,
  type NewTransmission,
} from '../../src/ereporting/ereporting.repository.js'
import { InvalidEreportingTransitionError } from '../../src/ereporting/ereporting-lifecycle.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Persistance e-reporting (Task 5, plan 2.3) : déclarants, transmissions,
// journal sous RLS FORCE + moindre privilège différencié, SD cross-tenant
// find_ereporting_declarants_due, et amendement A2 (idempotence anti
// double-envoi). Style e2e identique à poison-invoice/ledger-sealing/rls
// (2.1/2.2) : Postgres réel via Testcontainers, pools owner (BYPASSRLS,
// migrations) et app (factelec_app, moindre privilège).

const transmission = (
  declarantId: string,
  overrides: Partial<NewTransmission> = {},
): NewTransmission => ({
  declarantId,
  transmissionRef: 'TT-1',
  type: 'IN',
  fluxKind: 'transactions',
  periodStart: '20260701',
  periodEnd: '20260731',
  invoiceCount: 0,
  xml: null,
  ...overrides,
})

describe('e-reporting persistence (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: EreportingRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    // pg recommande TOUJOURS un écouteur `error` sur un Pool (cf. 2.2,
    // ledger-sealing.e2e.test.ts) : sans lui, une erreur sur un client IDLE
    // (57P01 au teardown du conteneur) est relancée et fait planter le
    // process — gate rouge intermittente.
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new EreportingRepository(new TenantContextService(appPool))
    tenantA = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('EREP-A') RETURNING id",
      )
    ).rows[0].id
    tenantB = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('EREP-B') RETURNING id",
      )
    ).rows[0].id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  // ── RLS FORCE : isolation des déclarants ─────────────────────────────────

  it('isole les déclarants par tenant (RLS FORCE)', async () => {
    const declarantA = (
      await ownerPool.query(
        `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
         VALUES ($1, '123456789', 'Vendeur A', 'SE', 'reel_normal_mensuel') RETURNING id`,
        [tenantA],
      )
    ).rows[0].id

    const asB = await appPool.connect()
    try {
      await asB.query('BEGIN')
      await asB.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      const r = await asB.query(
        'SELECT id FROM ereporting_declarants WHERE id = $1',
        [declarantA],
      )
      expect(r.rowCount).toBe(0)
      await asB.query('ROLLBACK')
    } finally {
      asB.release()
    }

    const asA = await appPool.connect()
    try {
      await asA.query('BEGIN')
      await asA.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      const r = await asA.query(
        'SELECT id FROM ereporting_declarants WHERE id = $1',
        [declarantA],
      )
      expect(r.rowCount).toBe(1)
      await asA.query('COMMIT')
    } finally {
      asA.release()
    }
  })

  it('interdit INSERT dans un autre tenant (WITH CHECK)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      await expect(
        client.query(
          `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
           VALUES ($1, '999999999', 'X', 'SE', 'franchise')`,
          [tenantA],
        ),
      ).rejects.toThrow(/row-level security/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // ── Moindre privilège différencié ────────────────────────────────────────

  it('interdit UPDATE/DELETE sur le journal e-reporting (42501, append-only)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE ereporting_status_events SET actor = 'x'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM ereporting_status_events'),
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
        client.query('DELETE FROM ereporting_transmissions'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('autorise DELETE sur les déclarants pour factelec_app (config opérateur mutable)', async () => {
    const throwaway = (
      await ownerPool.query(
        `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
         VALUES ($1, '111111111', 'Jetable', 'BY', 'simplifie') RETURNING id`,
        [tenantA],
      )
    ).rows[0].id
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM ereporting_declarants WHERE id = $1', [
          throwaway,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  // ── SD cross-tenant find_ereporting_declarants_due ───────────────────────

  it('find_ereporting_declarants_due voit les déclarants de tous les tenants, search_path épinglé, EXECUTE accordé à factelec_app', async () => {
    await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime, active)
       VALUES ($1, '222222222', 'Actif A', 'SE', 'reel_normal_mensuel', true)`,
      [tenantA],
    )
    await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime, active)
       VALUES ($1, '333333333', 'Actif B', 'BY', 'simplifie', true)`,
      [tenantB],
    )
    await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime, active)
       VALUES ($1, '444444444', 'Inactif A', 'SE', 'franchise', false)`,
      [tenantA],
    )

    // Appelée par factelec_app avec le contexte tenant A posé — la fonction
    // SECURITY DEFINER doit tout de même renvoyer les déclarants ACTIFS des
    // DEUX tenants (l'ordonnanceur, Task 7, tourne hors contexte tenant).
    const client = await appPool.connect()
    let rows: { tenant_id: string; siren: string }[]
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      rows = (
        await client.query('SELECT * FROM find_ereporting_declarants_due()')
      ).rows
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const sirens = rows.map((r) => r.siren).sort()
    expect(sirens).toContain('222222222')
    expect(sirens).toContain('333333333')
    expect(sirens).not.toContain('444444444') // inactif, exclu
    expect(rows.some((r) => r.tenant_id === tenantA)).toBe(true)
    expect(rows.some((r) => r.tenant_id === tenantB)).toBe(true)

    const meta = await ownerPool.query(
      `SELECT p.proconfig, has_function_privilege('factelec_app', p.oid, 'EXECUTE') AS app_can_exec
         FROM pg_proc p WHERE p.proname = 'find_ereporting_declarants_due'`,
    )
    expect(meta.rows).toHaveLength(1)
    expect(meta.rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp'])
    // Contrairement au trigger de scellement 2.2 (ledger_field/
    // seal_status_event), cette SD EST appelée par l'application (Task 7) :
    // EXECUTE doit être accordé à factelec_app (pas révoqué).
    expect(meta.rows[0].app_can_exec).toBe(true)
  })

  // ── FK RESTRICT : journal probatoire ─────────────────────────────────────

  it('bloque la suppression d’une transmission munie d’un journal (23503)', async () => {
    const declarantId = (
      await ownerPool.query(
        `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
         VALUES ($1, '555555555', 'FK', 'SE', 'reel_normal_trimestriel') RETURNING id`,
        [tenantA],
      )
    ).rows[0].id
    const { id } = await repo.insertTransmission(
      tenantA,
      transmission(declarantId, { transmissionRef: 'TT-FK' }),
    )
    // insertTransmission a écrit l'événement initial `prepared` → le
    // RESTRICT bloque la suppression, même pour l'owner (BYPASSRLS n'exempte
    // pas des FK).
    await expect(
      ownerPool.query('DELETE FROM ereporting_transmissions WHERE id = $1', [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  // ── Amendement A2 : idempotence anti double-envoi ────────────────────────

  describe('A2 — idempotence insertTransmission', () => {
    it('deux insertTransmission(IN) identiques (déclarant, flux, période) → 1 seule ligne, 2e appel created:false', async () => {
      const declarantId = (
        await ownerPool.query(
          `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
           VALUES ($1, '666666666', 'Idem', 'SE', 'simplifie') RETURNING id`,
          [tenantA],
        )
      ).rows[0].id

      const first = await repo.insertTransmission(
        tenantA,
        transmission(declarantId, { transmissionRef: 'TT-IDEM-1' }),
      )
      expect(first.created).toBe(true)

      const second = await repo.insertTransmission(
        tenantA,
        transmission(declarantId, { transmissionRef: 'TT-IDEM-2' }),
      )
      expect(second.created).toBe(false)
      expect(second.id).toBe(first.id)

      const rows = await ownerPool.query(
        `SELECT count(*)::int AS n FROM ereporting_transmissions
         WHERE declarant_id = $1 AND flux_kind = 'transactions' AND period_start = '20260701' AND type = 'IN'`,
        [declarantId],
      )
      expect(rows.rows[0].n).toBe(1)

      // Le 2e appel (idempotent, created:false) N'A PAS écrit de second
      // événement journal initial — un seul `prepared` pour la ligne unique.
      const events = await repo.listStatusEvents(tenantA, first.id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'prepared',
        actor: 'platform',
      })
    })

    it("un rectificatif ('RE') sur la même période est accepté comme ligne distincte", async () => {
      const declarantId = (
        await ownerPool.query(
          `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
           VALUES ($1, '777777777', 'RE', 'SE', 'simplifie') RETURNING id`,
          [tenantA],
        )
      ).rows[0].id

      const initial = await repo.insertTransmission(
        tenantA,
        transmission(declarantId, { transmissionRef: 'TT-RE-IN' }),
      )
      expect(initial.created).toBe(true)

      const rectificatif = await repo.insertTransmission(
        tenantA,
        transmission(declarantId, {
          transmissionRef: 'TT-RE-1',
          type: 'RE',
        }),
      )
      expect(rectificatif.created).toBe(true)
      expect(rectificatif.id).not.toBe(initial.id)

      // Un second RE sur la même période est ÉGALEMENT accepté (RE libres —
      // aucun index partiel ne les contraint).
      const secondRectificatif = await repo.insertTransmission(
        tenantA,
        transmission(declarantId, {
          transmissionRef: 'TT-RE-2',
          type: 'RE',
        }),
      )
      expect(secondRectificatif.created).toBe(true)
      expect(secondRectificatif.id).not.toBe(rectificatif.id)

      const rows = await ownerPool.query(
        `SELECT type FROM ereporting_transmissions WHERE declarant_id = $1 ORDER BY created_at`,
        [declarantId],
      )
      expect(rows.rows.map((r) => r.type)).toEqual(['IN', 'RE', 'RE'])
    })
  })

  // ── Repository : déclarants ──────────────────────────────────────────────

  describe('EreportingRepository — déclarants', () => {
    it('upsertDeclarant insère puis met à jour (idempotence tenant×siren×rôle)', async () => {
      const created = await repo.upsertDeclarant(tenantA, {
        siren: '888888888',
        name: 'Initial',
        role: 'SE',
        vatRegime: 'simplifie',
      })
      const updated = await repo.upsertDeclarant(tenantA, {
        siren: '888888888',
        name: 'Renommé',
        role: 'SE',
        vatRegime: 'reel_normal_mensuel',
        active: false,
      })
      expect(updated.id).toBe(created.id)

      const rows = await ownerPool.query(
        'SELECT name, vat_regime, active FROM ereporting_declarants WHERE id = $1',
        [created.id],
      )
      expect(rows.rows[0]).toMatchObject({
        name: 'Renommé',
        vat_regime: 'reel_normal_mensuel',
        active: false,
      })
    })

    it('listDeclarantsByTenant renvoie les déclarants du tenant courant (RLS)', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('EREP-LIST') RETURNING id",
        )
      ).rows[0].id
      await repo.upsertDeclarant(t, {
        siren: '100000001',
        name: 'L1',
        role: 'SE',
        vatRegime: 'simplifie',
      })
      await repo.upsertDeclarant(t, {
        siren: '100000002',
        name: 'L2',
        role: 'BY',
        vatRegime: 'franchise',
      })

      const list = await repo.listDeclarantsByTenant(t)
      expect(list).toHaveLength(2)
      expect(list.map((d) => d.siren).sort()).toEqual([
        '100000001',
        '100000002',
      ])
    })
  })

  // ── Repository : transitions du cycle de vie ─────────────────────────────

  describe('EreportingRepository — transitions', () => {
    it('markTransmitted : prepared→transmitted (trackingId + journal), rejette une transition périmée', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('EREP-TRANS') RETURNING id",
        )
      ).rows[0].id
      const declarantId = (
        await ownerPool.query(
          `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
           VALUES ($1, '900000001', 'T', 'SE', 'simplifie') RETURNING id`,
          [t],
        )
      ).rows[0].id
      const { id } = await repo.insertTransmission(
        t,
        transmission(declarantId, { transmissionRef: 'TT-MT-1' }),
      )

      await repo.markTransmitted(t, id, 'TRACK-1')

      const row = await ownerPool.query(
        'SELECT status, tracking_id FROM ereporting_transmissions WHERE id = $1',
        [id],
      )
      expect(row.rows[0]).toMatchObject({
        status: 'transmitted',
        tracking_id: 'TRACK-1',
      })
      const events = await repo.listStatusEvents(t, id)
      expect(events.map((e) => e.toStatus)).toEqual(['prepared', 'transmitted'])

      // Rejouer markTransmitted (déjà `transmitted`, plus `prepared`) : CAS
      // périmé → CasStaleError (D8, détection par type), aucun événement
      // supplémentaire.
      const staleReplay = repo.markTransmitted(t, id, 'TRACK-2')
      await expect(staleReplay).rejects.toBeInstanceOf(CasStaleError)
      await expect(staleReplay).rejects.toThrow(/not in 'prepared' status/)
      expect(await repo.listStatusEvents(t, id)).toHaveLength(2)
    })

    it('appendStatusEvent : transmitted→deposee sans motif, exige un motif pour →rejetee, rejette une transition invalide et une transition périmée', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('EREP-EVENTS') RETURNING id",
        )
      ).rows[0].id
      const declarantId = (
        await ownerPool.query(
          `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
           VALUES ($1, '900000002', 'E', 'SE', 'simplifie') RETURNING id`,
          [t],
        )
      ).rows[0].id
      const { id: idDeposee } = await repo.insertTransmission(
        t,
        transmission(declarantId, { transmissionRef: 'TT-EV-DEP' }),
      )
      await repo.markTransmitted(t, idDeposee, 'TRACK-DEP')
      await repo.appendStatusEvent(
        t,
        idDeposee,
        'transmitted',
        'deposee',
        'ppf',
      )
      expect(
        (
          await ownerPool.query(
            'SELECT status FROM ereporting_transmissions WHERE id = $1',
            [idDeposee],
          )
        ).rows[0].status,
      ).toBe('deposee')

      // deposee est TERMINAL (Task 4) : toute nouvelle transition est invalide.
      await expect(
        repo.appendStatusEvent(t, idDeposee, 'deposee', 'rejetee', 'ppf'),
      ).rejects.toBeInstanceOf(InvalidEreportingTransitionError)

      const { id: idRejetee } = await repo.insertTransmission(
        t,
        transmission(declarantId, {
          transmissionRef: 'TT-EV-REJ',
          periodStart: '20260801',
          periodEnd: '20260831',
        }),
      )
      await repo.markTransmitted(t, idRejetee, 'TRACK-REJ')

      await expect(
        repo.appendStatusEvent(t, idRejetee, 'transmitted', 'rejetee', 'ppf'),
      ).rejects.toThrow(/motif is required/)

      await repo.appendStatusEvent(
        t,
        idRejetee,
        'transmitted',
        'rejetee',
        'ppf',
        'REJ_SEMAN',
      )
      const events = await repo.listStatusEvents(t, idRejetee)
      expect(events.at(-1)).toMatchObject({
        fromStatus: 'transmitted',
        toStatus: 'rejetee',
        motif: 'REJ_SEMAN',
        actor: 'ppf',
      })

      // CAS périmé : la transmission n'est plus `transmitted` → CasStaleError
      // (D8, détection par type).
      const staleAppend = repo.appendStatusEvent(
        t,
        idRejetee,
        'transmitted',
        'rejetee',
        'ppf',
        'REJ_SEMAN',
      )
      await expect(staleAppend).rejects.toBeInstanceOf(CasStaleError)
      await expect(staleAppend).rejects.toThrow(/not in 'transmitted' status/)
    })
  })

  // ── Repository : lectures ────────────────────────────────────────────────

  describe('EreportingRepository — lectures', () => {
    it('listTransmissions, loadTransmissionXml : contenu et absence', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('EREP-READ') RETURNING id",
        )
      ).rows[0].id
      const declarantId = (
        await ownerPool.query(
          `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
           VALUES ($1, '900000003', 'R', 'SE', 'simplifie') RETURNING id`,
          [t],
        )
      ).rows[0].id
      const { id } = await repo.insertTransmission(
        t,
        transmission(declarantId, {
          transmissionRef: 'TT-READ-1',
          xml: '<Report/>',
          invoiceCount: 3,
        }),
      )

      const list = await repo.listTransmissions(t)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        id,
        transmissionRef: 'TT-READ-1',
        invoiceCount: 3,
        status: 'prepared',
      })

      expect(await repo.loadTransmissionXml(t, id)).toBe('<Report/>')
      expect(
        await repo.loadTransmissionXml(
          t,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).toBeNull()
    })

    it('invoicesForPeriod : filtre par période et par rôle (siren vendeur/acheteur)', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('EREP-PERIOD') RETURNING id",
        )
      ).rows[0].id
      const insert = async (
        number: string,
        issueDate: string,
        sellerSiren: string,
        buyerSiren: string,
      ) =>
        ownerPool.query(
          `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
           VALUES ($1, $2, '380', $3, 'EUR', $4::jsonb)`,
          [
            t,
            number,
            issueDate,
            JSON.stringify({
              number,
              seller: { siren: sellerSiren },
              buyer: { siren: buyerSiren },
            }),
          ],
        )
      await insert('P-IN-1', '2026-07-05', '111111111', '222222222')
      await insert('P-IN-2', '2026-07-20', '111111111', '333333333')
      await insert('P-OUT-1', '2026-06-30', '111111111', '222222222') // hors période (avant)
      await insert('P-OUT-2', '2026-08-01', '111111111', '222222222') // hors période (après)
      await insert('P-OTHER-SELLER', '2026-07-10', '999999999', '222222222') // autre vendeur

      const asSeller = await repo.invoicesForPeriod(
        t,
        '111111111',
        'SE',
        '2026-07-01',
        '2026-07-31',
      )
      expect(asSeller.map((i) => i.number).sort()).toEqual(['P-IN-1', 'P-IN-2'])

      const asBuyer = await repo.invoicesForPeriod(
        t,
        '222222222',
        'BY',
        '2026-07-01',
        '2026-07-31',
      )
      // P-OTHER-SELLER partage le même acheteur (222222222) et tombe dans la
      // période — seul le vendeur diffère, non filtrant ici (rôle BY).
      expect(asBuyer.map((i) => i.number).sort()).toEqual([
        'P-IN-1',
        'P-OTHER-SELLER',
      ])
    })
  })
})
