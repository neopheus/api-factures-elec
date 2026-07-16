import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AnnuaireRepository,
  LigneSlotConflictError,
  type NewLigne,
} from '../../src/annuaire/annuaire.repository.js'
import { InvalidAnnuaireTransitionError } from '../../src/annuaire/annuaire-lifecycle.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Persistance annuaire Flux 13/14 (Task 5, plan 2.4) : consentements, lignes
// de publication, journal (append-only, non scellé), miroir de consultation
// sous RLS FORCE + moindre privilège différencié, SD cross-tenant
// find_annuaire_sync_targets, et les 3 amendements ratifiés
// A-DEADLOCK/A-CONSENT/A-MIRROR-KEY (.superpowers/sdd/plan-2-4-review.md).
// Style e2e identique à ereporting-persistence.e2e.test.ts (2.3) : Postgres
// réel via Testcontainers, pools owner (BYPASSRLS, fixtures directes) et app
// (factelec_app, moindre privilège).

async function insertConsentRaw(
  pool: pg.Pool,
  tenantId: string,
  siren: string,
): Promise<string> {
  return (
    await pool.query(
      `INSERT INTO annuaire_consents (tenant_id, siren, consent_type, signer_identity, evidence_ref, obtained_at)
       VALUES ($1, $2, 'mandat', 'Signataire Test', 'EVID-1', now()) RETURNING id`,
      [tenantId, siren],
    )
  ).rows[0].id
}

async function insertLigneRaw(
  pool: pg.Pool,
  tenantId: string,
  consentId: string,
  overrides: {
    siren?: string
    dateDebut?: string
    nature?: string
    status?: string
    plateforme?: string
  } = {},
): Promise<string> {
  return (
    await pool.query(
      `INSERT INTO annuaire_lignes (tenant_id, siren, nature, date_debut, plateforme, status, consent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        tenantId,
        overrides.siren ?? '100000001',
        overrides.nature ?? 'D',
        overrides.dateDebut ?? '20260101',
        overrides.plateforme ?? '0001',
        overrides.status ?? 'draft',
        consentId,
      ],
    )
  ).rows[0].id
}

describe('annuaire persistence (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: AnnuaireRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    // pg recommande TOUJOURS un écouteur `error` sur un Pool (cf. 2.2/2.3) :
    // sans lui, une erreur sur un client IDLE (57P01 au teardown du
    // conteneur) est relancée et fait planter le process.
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new AnnuaireRepository(new TenantContextService(appPool))
    tenantA = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('ANN-A') RETURNING id",
      )
    ).rows[0].id
    tenantB = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('ANN-B') RETURNING id",
      )
    ).rows[0].id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  // ── RLS FORCE : isolation des 4 tables ───────────────────────────────────

  it('isole les consentements, lignes et le miroir par tenant (RLS FORCE)', async () => {
    const consentIdA = await insertConsentRaw(ownerPool, tenantA, '111111111')
    const ligneIdA = await insertLigneRaw(ownerPool, tenantA, consentIdA, {
      siren: '111111111',
    })
    await ownerPool.query(
      `INSERT INTO annuaire_directory_entries (tenant_id, siren, nature, date_debut, plateforme)
       VALUES ($1, '111111111', 'D', '20260101', '0001')`,
      [tenantA],
    )

    const asB = await appPool.connect()
    try {
      await asB.query('BEGIN')
      await asB.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      expect(
        (
          await asB.query('SELECT id FROM annuaire_consents WHERE id = $1', [
            consentIdA,
          ])
        ).rowCount,
      ).toBe(0)
      expect(
        (
          await asB.query('SELECT id FROM annuaire_lignes WHERE id = $1', [
            ligneIdA,
          ])
        ).rowCount,
      ).toBe(0)
      expect(
        (
          await asB.query(
            "SELECT id FROM annuaire_directory_entries WHERE siren = '111111111'",
          )
        ).rowCount,
      ).toBe(0)
      await asB.query('ROLLBACK')
    } finally {
      asB.release()
    }

    const asA = await appPool.connect()
    try {
      await asA.query('BEGIN')
      await asA.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      expect(
        (
          await asA.query('SELECT id FROM annuaire_consents WHERE id = $1', [
            consentIdA,
          ])
        ).rowCount,
      ).toBe(1)
      expect(
        (
          await asA.query('SELECT id FROM annuaire_lignes WHERE id = $1', [
            ligneIdA,
          ])
        ).rowCount,
      ).toBe(1)
      expect(
        (
          await asA.query(
            "SELECT id FROM annuaire_directory_entries WHERE siren = '111111111'",
          )
        ).rowCount,
      ).toBe(1)
      // WITH CHECK : interdit d'INSÉRER sous couvert d'un autre tenant que
      // celui posé dans la session (même avec le contexte A actif).
      await expect(
        asA.query(
          `INSERT INTO annuaire_consents (tenant_id, siren, consent_type, signer_identity, evidence_ref, obtained_at)
           VALUES ($1, '999999999', 'mandat', 'X', 'EVID-X', now())`,
          [tenantB],
        ),
      ).rejects.toThrow(/row-level security/i)
      await asA.query('ROLLBACK')
    } finally {
      asA.release()
    }
  })

  // ── Moindre privilège différencié ────────────────────────────────────────

  it('interdit UPDATE/DELETE sur le journal annuaire (42501, append-only)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query("UPDATE annuaire_ligne_events SET actor = 'x'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM annuaire_ligne_events'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('interdit DELETE sur les lignes (42501, masquage = update de statut, pas de suppression)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM annuaire_lignes'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('interdit DELETE sur les consentements (42501, révocation par revokedAt)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await expect(
        client.query('DELETE FROM annuaire_consents'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('autorise DELETE sur le miroir de consultation (régénérable par la sync)', async () => {
    const throwaway = (
      await ownerPool.query(
        `INSERT INTO annuaire_directory_entries (tenant_id, siren, nature, date_debut, plateforme)
         VALUES ($1, '222222222', 'D', '20260101', '0001') RETURNING id`,
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
        client.query('DELETE FROM annuaire_directory_entries WHERE id = $1', [
          throwaway,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  // ── SD cross-tenant find_annuaire_sync_targets ───────────────────────────

  it('find_annuaire_sync_targets voit les tenants de tous les tenants, search_path épinglé, EXECUTE accordé à factelec_app', async () => {
    const client = await appPool.connect()
    let rows: { tenant_id: string }[]
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      rows = (await client.query('SELECT * FROM find_annuaire_sync_targets()'))
        .rows
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const ids = rows.map((r) => r.tenant_id)
    expect(ids).toContain(tenantA)
    expect(ids).toContain(tenantB)

    const meta = await ownerPool.query(
      `SELECT p.proconfig, has_function_privilege('factelec_app', p.oid, 'EXECUTE') AS app_can_exec
         FROM pg_proc p WHERE p.proname = 'find_annuaire_sync_targets'`,
    )
    expect(meta.rows).toHaveLength(1)
    expect(meta.rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp'])
    expect(meta.rows[0].app_can_exec).toBe(true)
  })

  // ── Index partiel (baseline plan) : conflit sur une définition active ────

  it('rejette une 2e définition sur la même maille×date active (23505, index partiel)', async () => {
    const consentId = await insertConsentRaw(ownerPool, tenantA, '333333333')
    await insertLigneRaw(ownerPool, tenantA, consentId, {
      siren: '333333333',
      dateDebut: '20260301',
      status: 'draft',
    })
    await expect(
      insertLigneRaw(ownerPool, tenantA, consentId, {
        siren: '333333333',
        dateDebut: '20260301',
        status: 'draft',
      }),
    ).rejects.toMatchObject({ code: '23505' })
  })

  // ── FK RESTRICT : journal probatoire ──────────────────────────────────────

  it('bloque la suppression d’une ligne munie d’un journal (23503)', async () => {
    const consentId = await insertConsentRaw(ownerPool, tenantA, '444444444')
    const { id } = await repo.insertLigne(tenantA, {
      siren: '444444444',
      nature: 'D',
      dateDebut: '20260401',
      plateforme: '0001',
      consentId,
    })
    await expect(
      ownerPool.query('DELETE FROM annuaire_lignes WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('insertLigne propage TEL QUEL un conflit non lié au slot (ex. 23503 FK sur consentId inconnu)', async () => {
    // drizzle-orm (>=0.36) enveloppe l'erreur pg dans une DrizzleQueryError —
    // le SQLSTATE original vit sur `.cause` (cf. isLigneSlotConflict), pas
    // au premier niveau.
    await expect(
      repo.insertLigne(tenantA, {
        siren: '600000123',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0001',
        consentId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } })
  })

  // ── Amendement A-DEADLOCK (HIGH, prime sur le plan) ──────────────────────

  describe('A-DEADLOCK — libération du slot après rejet/masquage, blocage tant que la ligne est active', () => {
    it('après rejet (published→rejetee) de la maille×date, une re-définition est ACCEPTÉE', async () => {
      const consentId = await insertConsentRaw(ownerPool, tenantA, '500000001')
      const ligne: NewLigne = {
        siren: '500000001',
        nature: 'D',
        dateDebut: '20260501',
        plateforme: '0001',
        consentId,
      }
      const { id } = await repo.insertLigne(tenantA, ligne)
      await repo.markPublished(tenantA, id, 'TRACK-1')
      await repo.appendLigneEvent(
        tenantA,
        id,
        'published',
        'rejetee',
        'ppf',
        'motif libre de rejet',
      )

      // Re-définition de la MÊME maille×date : le slot est libéré.
      const redefined = await repo.insertLigne(tenantA, ligne)
      expect(redefined.id).not.toBe(id)
      const rows = await repo.listLignes(tenantA)
      expect(
        rows.filter(
          (r) => r.siren === '500000001' && r.dateDebut === '20260501',
        ),
      ).toHaveLength(2)
    })

    it('après masquage (deposee→masked) de la maille×date, une re-définition est ACCEPTÉE', async () => {
      const consentId = await insertConsentRaw(ownerPool, tenantA, '500000002')
      const ligne: NewLigne = {
        siren: '500000002',
        nature: 'D',
        dateDebut: '20260502',
        plateforme: '0001',
        consentId,
      }
      const { id } = await repo.insertLigne(tenantA, ligne)
      await repo.markPublished(tenantA, id, 'TRACK-2')
      await repo.appendLigneEvent(tenantA, id, 'published', 'deposee', 'ppf')
      await repo.appendLigneEvent(tenantA, id, 'deposee', 'masked', 'platform')

      const redefined = await repo.insertLigne(tenantA, ligne)
      expect(redefined.id).not.toBe(id)
    })

    it('une 2e Définition contre une ligne ACTIVE draft → LigneSlotConflictError', async () => {
      const consentId = await insertConsentRaw(ownerPool, tenantA, '500000101')
      const ligne: NewLigne = {
        siren: '500000101',
        nature: 'D',
        dateDebut: '20260601',
        plateforme: '0001',
        consentId,
      }
      await repo.insertLigne(tenantA, ligne)
      await expect(repo.insertLigne(tenantA, ligne)).rejects.toBeInstanceOf(
        LigneSlotConflictError,
      )
    })

    it('une 2e Définition contre une ligne ACTIVE published → LigneSlotConflictError', async () => {
      const consentId = await insertConsentRaw(ownerPool, tenantA, '500000102')
      const ligne: NewLigne = {
        siren: '500000102',
        nature: 'D',
        dateDebut: '20260601',
        plateforme: '0001',
        consentId,
      }
      const { id } = await repo.insertLigne(tenantA, ligne)
      await repo.markPublished(tenantA, id, 'TRACK-3')
      await expect(repo.insertLigne(tenantA, ligne)).rejects.toBeInstanceOf(
        LigneSlotConflictError,
      )
    })

    it('une 2e Définition contre une ligne ACTIVE deposee → LigneSlotConflictError', async () => {
      const consentId = await insertConsentRaw(ownerPool, tenantA, '500000103')
      const ligne: NewLigne = {
        siren: '500000103',
        nature: 'D',
        dateDebut: '20260601',
        plateforme: '0001',
        consentId,
      }
      const { id } = await repo.insertLigne(tenantA, ligne)
      await repo.markPublished(tenantA, id, 'TRACK-4')
      await repo.appendLigneEvent(tenantA, id, 'published', 'deposee', 'ppf')
      await expect(repo.insertLigne(tenantA, ligne)).rejects.toBeInstanceOf(
        LigneSlotConflictError,
      )
    })
  })

  // ── Amendement A-CONSENT (HIGH) ──────────────────────────────────────────

  describe('A-CONSENT — couverture du consentement (maille égale ou plus large, non révoqué)', () => {
    let t: string
    beforeAll(async () => {
      t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('ANN-CONSENT') RETURNING id",
        )
      ).rows[0].id
    })

    it('un consentement SIREN couvre une publication SIRET du même SIREN (large→étroit, ACCEPTÉE)', async () => {
      await repo.insertConsent(t, {
        siren: '600000001',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID-SIREN',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })
      const found = await repo.findActiveConsent(t, {
        siren: '600000001',
        siret: '60000000100012',
      })
      expect(found).not.toBeNull()
      expect(found?.siren).toBe('600000001')
    })

    it('un consentement SIRET ne couvre PAS une publication SIREN nue du même SIREN (étroit→large, REFUSÉE)', async () => {
      await repo.insertConsent(t, {
        siren: '600000002',
        siret: '60000000200011',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID-SIRET',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })
      const found = await repo.findActiveConsent(t, { siren: '600000002' })
      expect(found).toBeNull()
    })

    it('un consentement révoqué ne couvre plus rien (REFUSÉE)', async () => {
      const { id } = await repo.insertConsent(t, {
        siren: '600000003',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID-REV',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })
      await ownerPool.query(
        'UPDATE annuaire_consents SET revoked_at = now() WHERE id = $1',
        [id],
      )
      const found = await repo.findActiveConsent(t, { siren: '600000003' })
      expect(found).toBeNull()
    })

    it("un consentement d'un AUTRE SIREN ne couvre rien (REFUSÉE)", async () => {
      await repo.insertConsent(t, {
        siren: '600000004',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID-OTHER',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })
      const found = await repo.findActiveConsent(t, { siren: '600000099' })
      expect(found).toBeNull()
    })
  })

  // ── Amendement A-MIRROR-KEY (MED) ────────────────────────────────────────

  describe('A-MIRROR-KEY — la clé du miroir inclut `nature` (D et M coexistent)', () => {
    it('upsert D puis M sur la même maille×date → 2 lignes distinctes ; ré-upsert D → idempotent', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('ANN-MIRROR') RETURNING id",
        )
      ).rows[0].id
      const siren = '700000001'
      await repo.upsertDirectoryEntries(t, [
        {
          siren,
          nature: 'D',
          dateDebut: '20260701',
          plateforme: '0001',
          idInstance: 42,
          sourceHorodate: '20260701090000',
        },
      ])
      await repo.upsertDirectoryEntries(t, [
        {
          siren,
          nature: 'M',
          dateDebut: '20260701',
          plateforme: '0001',
        },
      ])
      let entries = await repo.findDirectoryEntries(t, siren)
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.nature).sort()).toEqual(['D', 'M'])

      // Ré-upsert de la Définition (même maille×date×nature) : idempotent —
      // seule la ligne 'D' est mise à jour (plateforme changée), le compte
      // total reste 2 (pas de 3e ligne créée).
      await repo.upsertDirectoryEntries(t, [
        {
          siren,
          nature: 'D',
          dateDebut: '20260701',
          plateforme: '0002',
        },
      ])
      entries = await repo.findDirectoryEntries(t, siren)
      expect(entries).toHaveLength(2)
      const d = entries.find((e) => e.nature === 'D')
      expect(d?.plateforme).toBe('0002')
    })
  })

  // ── Repository : cycle de vie des lignes ─────────────────────────────────

  describe('AnnuaireRepository — cycle de vie des lignes', () => {
    it('insertLigne écrit la ligne + événement genèse draft (même transaction)', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('ANN-LIGNE') RETURNING id",
        )
      ).rows[0].id
      const { id: consentId } = await repo.insertConsent(t, {
        siren: '800000001',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })
      const { id } = await repo.insertLigne(t, {
        siren: '800000001',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0001',
        consentId,
      })
      const events = await repo.listLigneEvents(t, id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'draft',
        actor: 'platform',
      })
      const lignes = await repo.listLignes(t)
      expect(lignes.find((l) => l.id === id)).toMatchObject({
        status: 'draft',
        consentId,
      })
    })

    it('markPublished : draft→published (trackingRef + journal), rejette une transition périmée', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('ANN-PUBLISH') RETURNING id",
        )
      ).rows[0].id
      const { id: consentId } = await repo.insertConsent(t, {
        siren: '800000002',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })
      const { id } = await repo.insertLigne(t, {
        siren: '800000002',
        nature: 'D',
        dateDebut: '20260201',
        plateforme: '0001',
        consentId,
      })

      await repo.markPublished(t, id, 'TRACK-A')

      const lignes = await repo.listLignes(t)
      expect(lignes.find((l) => l.id === id)).toMatchObject({
        status: 'published',
        trackingRef: 'TRACK-A',
      })
      const events = await repo.listLigneEvents(t, id)
      expect(events.map((e) => e.toStatus)).toEqual(['draft', 'published'])

      await expect(repo.markPublished(t, id, 'TRACK-B')).rejects.toThrow(
        /not in 'draft' status/,
      )
      expect(await repo.listLigneEvents(t, id)).toHaveLength(2)
    })

    it('appendLigneEvent : published→deposee sans motif, exige un motif pour →rejetee, rejette une transition invalide et une transition périmée', async () => {
      const t = (
        await ownerPool.query(
          "INSERT INTO tenants (name) VALUES ('ANN-EVENTS') RETURNING id",
        )
      ).rows[0].id
      const { id: consentId } = await repo.insertConsent(t, {
        siren: '800000003',
        consentType: 'mandat',
        signerIdentity: 'Signataire',
        evidenceRef: 'EVID',
        obtainedAt: new Date('2026-01-01T00:00:00Z'),
      })

      // Transition structurellement invalide : draft → rejetee (interdite,
      // seul published→rejetee l'est) — assertTransition échoue AVANT toute
      // vérification de motif.
      const { id: idInvalid } = await repo.insertLigne(t, {
        siren: '800000003',
        nature: 'D',
        dateDebut: '20260301',
        plateforme: '0001',
        consentId,
      })
      await expect(
        repo.appendLigneEvent(t, idInvalid, 'draft', 'rejetee', 'ppf'),
      ).rejects.toBeInstanceOf(InvalidAnnuaireTransitionError)

      const { id: idDeposee } = await repo.insertLigne(t, {
        siren: '800000004',
        nature: 'D',
        dateDebut: '20260301',
        plateforme: '0001',
        consentId,
      })
      await repo.markPublished(t, idDeposee, 'TRACK-DEP')
      await repo.appendLigneEvent(t, idDeposee, 'published', 'deposee', 'ppf')
      expect(
        (await repo.listLignes(t)).find((l) => l.id === idDeposee),
      ).toMatchObject({ status: 'deposee' })

      // deposee → masked est la SEULE transition valide depuis deposee.
      await expect(
        repo.appendLigneEvent(t, idDeposee, 'deposee', 'rejetee', 'ppf'),
      ).rejects.toBeInstanceOf(InvalidAnnuaireTransitionError)

      const { id: idRejetee } = await repo.insertLigne(t, {
        siren: '800000005',
        nature: 'D',
        dateDebut: '20260301',
        plateforme: '0001',
        consentId,
      })
      await repo.markPublished(t, idRejetee, 'TRACK-REJ')

      await expect(
        repo.appendLigneEvent(t, idRejetee, 'published', 'rejetee', 'ppf'),
      ).rejects.toThrow(/motif is required/)

      await repo.appendLigneEvent(
        t,
        idRejetee,
        'published',
        'rejetee',
        'ppf',
        'motif libre annuaire',
      )
      const events = await repo.listLigneEvents(t, idRejetee)
      expect(events.at(-1)).toMatchObject({
        fromStatus: 'published',
        toStatus: 'rejetee',
        motif: 'motif libre annuaire',
        actor: 'ppf',
      })
      expect(
        (await repo.listLignes(t)).find((l) => l.id === idRejetee),
      ).toMatchObject({
        status: 'rejetee',
        rejectReason: 'motif libre annuaire',
      })

      // CAS périmé : la ligne n'est plus `published`.
      await expect(
        repo.appendLigneEvent(
          t,
          idRejetee,
          'published',
          'rejetee',
          'ppf',
          'autre motif',
        ),
      ).rejects.toThrow(/not in 'published' status/)
    })
  })
})
