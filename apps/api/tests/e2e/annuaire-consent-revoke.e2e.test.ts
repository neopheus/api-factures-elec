import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AnnuairePort } from '../../src/annuaire/annuaire.port.js'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { AnnuairePublicationService } from '../../src/annuaire/annuaire-publication.service.js'
import type { ConsentSignaturePort } from '../../src/annuaire/consent-signature.port.js'
import { hashPassword } from '../../src/auth/password.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { extractCookie } from './helpers/session.js'

// Preuve d'intégration RÉELLE de l'endpoint opérateur de révocation de
// consentement (Task 1, plan 3.6, commit 495bb42) — IMPÉRATIF N1 (revue T1) :
// le writer repo/service/contrôleur n'était exercé qu'à travers des mocks
// (`annuaire-revoke.service.test.ts`) ; cette suite est le SEUL endroit qui
// prouve le CAS write-once sur Postgres réel, l'idempotence, le 404
// anti-fuite, l'isolation RLS et — surtout — la NON-RÉGRESSION du gate de
// publication (D2/D5) : un consentement révoqué doit continuer à bloquer
// TOUTE publication neuve, sur les deux chemins (`consentId` explicite ET
// auto-découverte). Postgres réel (`createTestApp`/`factelec_app`), AUCUN
// worker BullMQ ⇒ LIGHT (pas d'entrée `HEAVY_TESTS`, motif exact des
// fichiers modèles). Modèles repris verbatim : `annuaire-consent-seal.e2e
// .test.ts` (scellement/consentement, `repo.insertConsent` direct),
// `annuaire-publication.e2e.test.ts` (`directService`/`noopPort`/
// `noopConsentSignature` pour `recordAck` sans port réel, gate consentId/
// auto-découverte), `annuaire-mutation-guards.e2e.test.ts` (session+CSRF,
// rôle viewer, `sessionCookie` inséré directement dans `users` pour le
// tenant seedé par clé API).

function noopPort(): AnnuairePort {
  const boom = (method: string) => () => {
    throw new Error(`port.${method} ne doit jamais être appelé par recordAck`)
  }
  return {
    publish: boom('publish'),
    fetchConsultation: boom('fetchConsultation'),
    publicationStatus: boom('publicationStatus'),
  }
}

function noopConsentSignature(): ConsentSignaturePort {
  const boom = (method: string) => () => {
    throw new Error(
      `consentSignature.${method} ne doit jamais être appelé par recordAck`,
    )
  }
  return { seal: boom('seal'), verify: boom('verify') }
}

const PASSWORD = 'a-strong-password-1'

describe('annuaire consentement : révocation opérateur (e2e, Postgres réel, LIGHT)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: AnnuaireRepository
  let directService: AnnuairePublicationService
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
    directService = new AnnuairePublicationService(
      repo,
      noopPort(),
      noopConsentSignature(),
    )
    ;({ tenantId, token } = await seedTenantWithKey(
      ownerPool,
      'ANN-CONSENT-REVOKE',
    ))
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  async function seedConsent(
    siren: string,
    overrides: Record<string, unknown> = {},
    forTenantId = tenantId,
  ): Promise<{ id: string }> {
    return repo.insertConsent(forTenantId, {
      siren,
      consentType: 'mandat',
      signerIdentity: 'Signataire Révocation',
      evidenceRef: 'EVID-REVOKE',
      obtainedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    })
  }

  function ligneBody(overrides: Record<string, unknown> = {}) {
    return {
      siren: '930000000',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
      ...overrides,
    }
  }

  async function publishOk(overrides: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody(overrides))
      .set('Authorization', `Bearer ${token}`)
      .expect(201)
    return res.body as { id: string; status: string }
  }

  async function revokedAtOf(consentId: string): Promise<Date | null> {
    const row = await ownerPool.query(
      'SELECT revoked_at FROM annuaire_consents WHERE id = $1',
      [consentId],
    )
    return (row.rows[0]?.revoked_at as Date | undefined) ?? null
  }

  async function sessionCookie(
    email: string,
    role: 'owner' | 'viewer',
  ): Promise<string[]> {
    await ownerPool.query(
      'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [tenantId, email, await hashPassword(PASSWORD), role],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200)
    return login.headers['set-cookie'] as unknown as string[]
  }

  it('POST /annuaire/consents/:id/revoke → 200 { consentId, revokedAt, dependentActiveLignes }, revoked_at persisté — clé API ET session+CSRF+rôle', async () => {
    // ── clé API ──────────────────────────────────────────────────────────
    const { id: consentIdA } = await seedConsent('930000101')
    const resA = await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentIdA}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(resA.body).toEqual({
      consentId: consentIdA,
      revokedAt: expect.any(String),
      dependentActiveLignes: 0,
    })
    const persistedA = await revokedAtOf(consentIdA)
    expect(persistedA).not.toBeNull()
    expect((persistedA as Date).toISOString()).toBe(resA.body.revokedAt)

    // ── session + CSRF + rôle owner ─────────────────────────────────────
    const { id: consentIdB } = await seedConsent('930000102')
    const cookie = await sessionCookie('ann-revoke-owner@example.com', 'owner')
    const resB = await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentIdB}/revoke`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', extractCookie(cookie, 'factelec_csrf'))
      .expect(200)
    expect(resB.body).toEqual({
      consentId: consentIdB,
      revokedAt: expect.any(String),
      dependentActiveLignes: 0,
    })
    const persistedB = await revokedAtOf(consentIdB)
    expect((persistedB as Date).toISOString()).toBe(resB.body.revokedAt)
  })

  it('idempotence : 2e révocation → 200 MÊME revokedAt (write-once, jamais réécrit)', async () => {
    const { id: consentId } = await seedConsent('930000103')

    const first = await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const second = await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(second.body.revokedAt).toBe(first.body.revokedAt)
    expect(second.body).toEqual(first.body)

    const persisted = await revokedAtOf(consentId)
    expect((persisted as Date).toISOString()).toBe(first.body.revokedAt)
  })

  it('consentement d’un AUTRE tenant → 404 byte-identique ; id inconnu → 404 byte-identique ; :id malformé → 404 byte-identique', async () => {
    const { tenantId: otherTenantId } = await seedTenantWithKey(
      ownerPool,
      'ANN-CONSENT-REVOKE-OTHER-404',
    )
    const { id: otherConsentId } = await seedConsent(
      '930000201',
      {},
      otherTenantId,
    )

    const crossTenant = await request(app.getHttpServer())
      .post(`/annuaire/consents/${otherConsentId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
    const unknown = await request(app.getHttpServer())
      .post('/annuaire/consents/00000000-0000-0000-0000-000000000000/revoke')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
    const malformed = await request(app.getHttpServer())
      .post('/annuaire/consents/not-a-uuid/revoke')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)

    expect(crossTenant.headers['content-type']).toContain(
      'application/problem+json',
    )
    expect(crossTenant.body).toEqual(unknown.body)
    expect(unknown.body).toEqual(malformed.body)

    // Le consentement de l'autre tenant n'a subi aucune mutation fantôme.
    expect(await revokedAtOf(otherConsentId)).toBeNull()
  })

  it('sans dual-auth : session sans CSRF → 403 ; rôle viewer → 403 ; sans authentification → 401', async () => {
    const { id: consentId } = await seedConsent('930000301')

    const viewerCookie = await sessionCookie(
      'ann-revoke-viewer@example.com',
      'viewer',
    )
    await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Cookie', viewerCookie)
      .set('X-CSRF-Token', extractCookie(viewerCookie, 'factelec_csrf'))
      .expect(403)

    const ownerCookie = await sessionCookie(
      'ann-revoke-nocsrf@example.com',
      'owner',
    )
    await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Cookie', ownerCookie)
      .expect(403)

    await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .expect(401)

    expect(await revokedAtOf(consentId)).toBeNull()
  })

  it('NON-RÉGRESSION gate — chemin consentId : publier avec le consentId RÉVOQUÉ → 422 (ConsentRequired)', async () => {
    const siren = '930000401'
    const { id: consentId } = await seedConsent(siren)
    await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren, dateDebut: '20260401', consentId }))
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:business-rule-violation')

    const lignes = await repo.listLignes(tenantId)
    expect(lignes.some((l) => l.siren === siren)).toBe(false)
  })

  it('NON-RÉGRESSION gate — auto-découverte : après révocation du SEUL consentement couvrant, publier sans consentId/proof → 422', async () => {
    const siren = '930000402'
    const { id: consentId } = await seedConsent(siren)
    // CONTRÔLE POSITIF in-file (revue T2, NIT-1) : AVANT révocation, la même
    // maille publie en auto-découverte (201) — c'est la causalité complète :
    // seul le passage par /revoke fait basculer 201 → 422.
    const before = await publishOk({ siren, dateDebut: '20260401' })
    expect(before.status).toBe('published')

    await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren, dateDebut: '20260402' }))
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:business-rule-violation')

    // Seule la ligne du contrôle positif (pré-révocation, 20260401) existe —
    // la tentative post-révocation (20260402) n'a RIEN créé.
    const lignes = (await repo.listLignes(tenantId)).filter(
      (l) => l.siren === siren,
    )
    expect(lignes).toHaveLength(1)
    expect(lignes[0]?.dateDebut).toBe('20260401')
  })

  it('dependentActiveLignes reflète les lignes non terminales dépendantes (published/deposee comptées, masked/rejetee non)', async () => {
    const siren = '930000501'
    const { id: consentId } = await seedConsent(siren)

    const published = await publishOk({
      siren,
      dateDebut: '20260501',
      consentId,
    })
    expect(published.status).toBe('published')

    const toDeposee = await publishOk({
      siren,
      dateDebut: '20260502',
      consentId,
    })
    await directService.recordAck(tenantId, toDeposee.id, 'deposee')

    const toMasked = await publishOk({
      siren,
      dateDebut: '20260503',
      consentId,
    })
    await directService.recordAck(tenantId, toMasked.id, 'deposee')
    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${toMasked.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204)

    const toRejetee = await publishOk({
      siren,
      dateDebut: '20260504',
      consentId,
    })
    await directService.recordAck(
      tenantId,
      toRejetee.id,
      'rejetee',
      'motif e2e',
    )

    // Oracle indépendant : les 4 statuts sont vérifiés directement en base
    // AVANT la révocation, pour ne jamais prendre le comptage du service sur
    // parole.
    expect(await repo.findLigne(tenantId, published.id)).toMatchObject({
      status: 'published',
    })
    expect(await repo.findLigne(tenantId, toDeposee.id)).toMatchObject({
      status: 'deposee',
    })
    expect(await repo.findLigne(tenantId, toMasked.id)).toMatchObject({
      status: 'masked',
    })
    expect(await repo.findLigne(tenantId, toRejetee.id)).toMatchObject({
      status: 'rejetee',
    })

    const res = await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    // published + deposee comptées ; masked + rejetee exclues (2, pas 4).
    expect(res.body.dependentActiveLignes).toBe(2)
  })

  it('isolation multi-tenant : la révocation d’un tenant n’affecte pas le consentement homonyme d’un autre (RLS)', async () => {
    const siren = '930000601'
    const { tenantId: otherTenantId } = await seedTenantWithKey(
      ownerPool,
      'ANN-CONSENT-REVOKE-RLS',
    )
    const { id: consentIdA } = await seedConsent(siren)
    const { id: consentIdB } = await seedConsent(siren, {}, otherTenantId)

    await request(app.getHttpServer())
      .post(`/annuaire/consents/${consentIdA}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(await revokedAtOf(consentIdA)).not.toBeNull()
    expect(await revokedAtOf(consentIdB)).toBeNull()
  })
})
