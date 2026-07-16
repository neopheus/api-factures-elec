import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { signupSession } from './helpers/session.js'

// Endpoint de gestion « codes-routage publiés par le tenant » (Task 3, plan
// 3.3, D6) — le trou comblé ici : `GET /annuaire/lignes` (ci-dessus,
// annuaire-consultation.e2e.test.ts) lit le MIROIR DE CONSULTATION
// (`annuaire_directory_entries`, Flux 14 — ce que le tenant peut CHERCHER),
// alors qu'AUCUN endpoint n'exposait jusqu'ici `annuaire_lignes` (les
// lignes que le tenant a lui-même PUBLIÉES via `POST /annuaire/lignes`).
// `GET /annuaire/codes-routage?siren=` énumère ces lignes filtrées sur
// `routageId IS NOT NULL` (un "code-routage" = une maille
// SIREN_SIRET_ROUTAGE), dual-auth, RLS, 200/tableau-vide (JAMAIS 404 —
// énumération, pas résolution).
//
// Seed via les motifs EXISTANTS des e2e annuaire (`repo.insertLigne` +
// `markPublished`/`appendLigneEvent`, identiques à
// annuaire-publication.e2e.test.ts) : les 5 lignes couvrent les 5 valeurs
// RÉELLES de l'enum `annuaire_ligne_status` (amendement m4 — `deposee`
// incluse) pour prouver la vue de gestion honnête (aucun filtre de
// statut), plus une ligne SANS `routageId` pour prouver le filtre du
// repository.

describe('annuaire codes-routage — énumération de gestion (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: AnnuaireRepository
  let tenantId: string
  let token: string

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new AnnuaireRepository(new TenantContextService(appPool))
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ANN-ROUTAGE'))
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  async function seedConsent(
    tid: string,
    siren: string,
  ): Promise<{ id: string }> {
    return repo.insertConsent(tid, {
      siren,
      consentType: 'mandat',
      signerIdentity: 'Signataire E2E',
      evidenceRef: 'EVID-E2E',
      obtainedAt: new Date('2026-01-01T00:00:00Z'),
    })
  }

  // Fait progresser une ligne fraîchement insérée (statut initial `draft`)
  // jusqu'au statut cible demandé, EN RÉUTILISANT EXACTEMENT les mêmes
  // méthodes du repository que `annuaire-publication.e2e.test.ts`
  // (`markPublished`/`appendLigneEvent`) — aucune nouvelle API de test.
  async function seedLigneWithStatus(params: {
    tid: string
    siren: string
    routageId?: string
    dateDebut: string
    status: 'draft' | 'published' | 'deposee' | 'rejetee' | 'masked'
  }): Promise<{ id: string }> {
    const { tid, siren, routageId, dateDebut, status } = params
    const { id: consentId } = await seedConsent(tid, siren)
    const { id } = await repo.insertLigne(tid, {
      siren,
      routageId,
      nature: 'D',
      dateDebut,
      plateforme: '0001',
      consentId,
    })
    if (status === 'draft') return { id }
    await repo.markPublished(tid, id, `TRACK-${id}`)
    if (status === 'published') return { id }
    if (status === 'rejetee') {
      await repo.appendLigneEvent(
        tid,
        id,
        'published',
        'rejetee',
        'ppf',
        'motif de test',
      )
      return { id }
    }
    await repo.appendLigneEvent(tid, id, 'published', 'deposee', 'ppf')
    if (status === 'deposee') return { id }
    await repo.appendLigneEvent(tid, id, 'deposee', 'masked', 'platform')
    return { id }
  }

  // ── happy path : les 5 statuts réels de l'enum, vue de gestion honnête ──

  it('liste les codes-routage publiés par le tenant pour un SIREN (routageId non-null, avec status)', async () => {
    const siren = '930000001'
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-DRAFT',
      dateDebut: '20260101',
      status: 'draft',
    })
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-PUBLISHED',
      dateDebut: '20260102',
      status: 'published',
    })
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-DEPOSEE',
      dateDebut: '20260103',
      status: 'deposee',
    })
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-REJETEE',
      dateDebut: '20260104',
      status: 'rejetee',
    })
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-MASKED',
      dateDebut: '20260105',
      status: 'masked',
    })
    // Ligne SANS routageId (maille SIREN pure) : ne doit JAMAIS apparaître
    // dans l'énumération codes-routage (filtre `routageId IS NOT NULL`).
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      dateDebut: '20260106',
      status: 'draft',
    })

    const res = await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.codes).toHaveLength(5)
    expect(
      res.body.codes.map((c: { routageId: string }) => c.routageId).sort(),
    ).toEqual([
      'RTG-DEPOSEE',
      'RTG-DRAFT',
      'RTG-MASKED',
      'RTG-PUBLISHED',
      'RTG-REJETEE',
    ])
    // Vue de gestion honnête (amendement m4) : les 5 valeurs RÉELLES de
    // l'enum sont présentes, `deposee` incluse — aucun filtre de statut.
    expect(
      res.body.codes.map((c: { status: string }) => c.status).sort(),
    ).toEqual(['deposee', 'draft', 'masked', 'published', 'rejetee'])
    // Projection EXACTE (D6) — ni `id`, ni `siren`, ni `suffixe`, ni les
    // champs internes du cycle de vie (consentId/trackingRef/rejectReason).
    for (const code of res.body.codes) {
      expect(Object.keys(code).sort()).toEqual([
        'dateDebut',
        'dateFin',
        'plateforme',
        'routageId',
        'siret',
        'status',
      ])
    }
    // VALEURS épinglées en littéral sur UN code complet (revue T3, NIT-1) :
    // un swap de colonnes dans la projection (ex. plateforme↔siret,
    // dateDebut↔dateFin) passerait les assertions de clés/longueur — seule
    // l'égalité d'objet entier l'attrape.
    expect(
      res.body.codes.find(
        (c: { routageId: string }) => c.routageId === 'RTG-PUBLISHED',
      ),
    ).toEqual({
      routageId: 'RTG-PUBLISHED',
      siret: null,
      plateforme: '0001',
      status: 'published',
      dateDebut: '20260102',
      dateFin: null,
    })
  })

  // ── énumération : tableau vide, PAS 404 ──────────────────────────────────

  it('renvoie un tableau VIDE (pas 404) si aucun code pour ce SIREN', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren: '939999999' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ codes: [] })
  })

  // ── non-fuite RLS ─────────────────────────────────────────────────────────

  it('non-fuite RLS : un SIREN d’un autre tenant renvoie un tableau vide', async () => {
    const siren = '930000002'
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-OWNER-ONLY',
      dateDebut: '20260101',
      status: 'published',
    })
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'ANN-ROUTAGE-OTHER',
    )
    const res = await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren })
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200)
    expect(res.body).toEqual({ codes: [] })
  })

  // ── dual-auth : clé API ET session, 401 sans identifiants ────────────────

  it('dual-auth : clé API ET session acceptées ; sans auth → 401', async () => {
    const siren = '930000003'
    await seedLigneWithStatus({
      tid: tenantId,
      siren,
      routageId: 'RTG-DUAL-KEY',
      dateDebut: '20260101',
      status: 'published',
    })
    await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const email = 'annuaire-routage-session@example.com'
    const session = await signupSession(app, {
      email,
      password: 'a-strong-passphrase-123',
      organizationName: 'ANN-ROUTAGE-session',
      siren: null,
    })
    const sessionTenantId = (
      await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
        email,
      ])
    ).rows[0].tenant_id
    const sessionSiren = '930000004'
    await seedLigneWithStatus({
      tid: sessionTenantId,
      siren: sessionSiren,
      routageId: 'RTG-DUAL-SESSION',
      dateDebut: '20260101',
      status: 'published',
    })
    const sessionRes = await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren: sessionSiren })
      .set('Cookie', session.cookie)
      .expect(200)
    expect(sessionRes.body.codes).toHaveLength(1)

    await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren })
      .expect(401)
  })

  // ── DTO hardening : siren malformé ────────────────────────────────────────

  it('valide le SIREN (zod, 9 chiffres) → 422 si malformé', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/codes-routage')
      .query({ siren: '123' })
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
  })
})
