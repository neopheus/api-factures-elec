import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AnnuairePort } from '../../src/annuaire/annuaire.port.js'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { AnnuairePublicationService } from '../../src/annuaire/annuaire-publication.service.js'
import type { ConsentSignaturePort } from '../../src/annuaire/consent-signature.port.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Publication consent-gated + émission Flux 13 + acquittements PPF (Task 8,
// plan 2.4) — endpoints HTTP dual-auth (`POST`/`PUT`/`DELETE
// /annuaire/lignes`) exercés via `createTestApp` (port RÉEL
// `LocalFilesystemAnnuaireStore`, xmllint RÉEL — mêmes conditions que la
// prod locale, ANNUAIRE_DRIVER=local par défaut) ; `recordAck` — sans route
// HTTP dans cette tâche (D7, miroir `EreportingStatusService
// .recordPpfStatus`) — est exercé DIRECTEMENT via un second
// `AnnuairePublicationService` instancié à la main (port jamais appelé par
// cette méthode : `noopPort`, motif `neverCalledPort`
// ereporting-generation.e2e.test.ts).
//
// Rejet born-rejetee (F13 localement invalide) : couvert par
// annuaire-publication.service.test.ts (mock du validateur XSD) — non
// reproductible ici de façon déterministe, la frontière zod (Task 8)
// garantit déjà la conformité structurelle de tout ce qui atteint le
// service en e2e.

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

describe('annuaire publication consent-gated + F13 + acquittements (e2e)', () => {
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
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ANN-PUBLISH'))
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
  ): Promise<{ id: string }> {
    return repo.insertConsent(tenantId, {
      siren,
      consentType: 'mandat',
      signerIdentity: 'Signataire E2E',
      evidenceRef: 'EVID-E2E',
      obtainedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    })
  }

  function ligneBody(overrides: Record<string, unknown> = {}) {
    return {
      siren: '910000000',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
      ...overrides,
    }
  }

  async function publishOk(overrides: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody(overrides))
      .set('Authorization', `Bearer ${token}`)
      .expect(201)
    return res.body as {
      id: string
      status: string
      trackingRef: string | null
      rejectReason: string | null
    }
  }

  // ── Gate consentement (D5, A-CONSENT) ────────────────────────────────────

  it('REFUSE la publication sans consentement actif (422), AVANT toute écriture', async () => {
    const siren = '910000101'
    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren }))
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:business-rule-violation')
    const lignes = await repo.listLignes(tenantId)
    expect(lignes.some((l) => l.siren === siren)).toBe(false)
  })

  // ── Publication happy path (F13 XSD-validé réellement, xmllint réel) ────

  it('publie une ligne consentie : draft→published, F13 XSD-valide, trackingRef non nul', async () => {
    const siren = '910000102'
    await seedConsent(siren)
    const body = await publishOk({ siren, dateDebut: '20260102' })

    expect(body.status).toBe('published')
    expect(body.trackingRef).toBeTruthy()
    expect(body.rejectReason).toBeNull()

    const events = await repo.listLigneEvents(tenantId, body.id)
    expect(events.map((e) => e.toStatus)).toEqual(['draft', 'published'])
  })

  // ── Gate consentement : consentId explicite vs preuve inline ────────────

  it('crée le consentement via `proof` inline (pas de consentement pré-existant) puis publie', async () => {
    const siren = '910000103'
    const body = await publishOk({
      siren,
      dateDebut: '20260103',
      proof: {
        consentType: 'mandat',
        signerIdentity: 'Signataire Preuve',
        evidenceRef: 'EVID-PROOF',
        obtainedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(body.status).toBe('published')
  })

  it('référence un consentement EXISTANT via `consentId` explicite', async () => {
    const siren = '910000104'
    const { id: consentId } = await seedConsent(siren)
    const body = await publishOk({ siren, dateDebut: '20260104', consentId })
    expect(body.status).toBe('published')
  })

  it('refuse un `consentId` qui ne couvre PAS la maille demandée (422)', async () => {
    const siren = '910000105'
    const otherSiren = '910000106'
    const { id: consentId } = await seedConsent(otherSiren)
    await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren, dateDebut: '20260105', consentId }))
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
  })

  // ── dates [début, fin) à la frontière DTO (POST) ─────────────────────────

  it('accepte une dateFin strictement postérieure à dateDebut (persistée)', async () => {
    const siren = '910000114'
    await seedConsent(siren)
    const body = await publishOk({
      siren,
      dateDebut: '20260114',
      dateFin: '20260601',
    })
    expect(body.status).toBe('published')
    const row = await ownerPool.query(
      'SELECT date_fin FROM annuaire_lignes WHERE id = $1',
      [body.id],
    )
    expect(row.rows[0]).toEqual({ date_fin: '20260601' })
  })

  it('refuse (422, zod) une dateFin <= dateDebut dès la frontière DTO, sans atteindre le service', async () => {
    const siren = '910000115'
    await seedConsent(siren)
    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren, dateDebut: '20260115', dateFin: '20260115' }))
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
    const lignes = await repo.listLignes(tenantId)
    expect(lignes.some((l) => l.siren === siren)).toBe(false)
  })

  // ── ''→null (injection revue T5#1) ───────────────────────────────────────

  it("normalise siret/routageId/suffixe vides ('') en ABSENT — persistance NULL, jamais chaîne vide", async () => {
    const siren = '910000107'
    await seedConsent(siren)
    const body = await publishOk({
      siren,
      dateDebut: '20260107',
      siret: '',
      routageId: '',
      suffixe: '',
    })
    const row = await ownerPool.query(
      'SELECT siret, routage_id, suffixe FROM annuaire_lignes WHERE id = $1',
      [body.id],
    )
    expect(row.rows[0]).toEqual({
      siret: null,
      routage_id: null,
      suffixe: null,
    })
  })

  // ── A-DEADLOCK (HIGH) : slot-conflict 409 + libération après rejet ──────

  it('refuse une 2e définition sur la même maille×date active (409) ; libère le slot après rejet (201)', async () => {
    const siren = '910000108'
    await seedConsent(siren)
    const first = await publishOk({ siren, dateDebut: '20260108' })

    const conflictRes = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren, dateDebut: '20260108' }))
      .set('Authorization', `Bearer ${token}`)
      .expect(409)
    expect(conflictRes.body.type).toBe('urn:factelec:problem:conflict')

    await directService.recordAck(
      tenantId,
      first.id,
      'rejetee',
      'motif de rejet',
    )

    const redefined = await publishOk({ siren, dateDebut: '20260108' })
    expect(redefined.id).not.toBe(first.id)
    expect(redefined.status).toBe('published')
  })

  // ── Acquittements (recordAck, exercé directement — D7) ──────────────────

  it('applique un acquittement déposée (published→deposee) puis un masquage (deposee→masked)', async () => {
    const siren = '910000109'
    await seedConsent(siren)
    const { id } = await publishOk({ siren, dateDebut: '20260109' })

    await directService.recordAck(tenantId, id, 'deposee')
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'deposee',
    })

    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204)
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'masked',
    })

    // Un second masquage échoue (CAS périmé : déjà `masked`, pas `deposee`).
    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409)
  })

  it('applique un rejet AVEC motif (published→rejetee) ; refuse un rejet SANS motif', async () => {
    const siren = '910000110'
    await seedConsent(siren)
    const { id } = await publishOk({ siren, dateDebut: '20260110' })

    await expect(
      directService.recordAck(tenantId, id, 'rejetee'),
    ).rejects.toThrow(/motif/)
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'published',
    })

    await directService.recordAck(
      tenantId,
      id,
      'rejetee',
      'motif réel de rejet',
    )
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'rejetee',
      rejectReason: 'motif réel de rejet',
    })

    // Un second acquittement échoue : `rejetee` est TERMINAL.
    await expect(
      directService.recordAck(tenantId, id, 'deposee'),
    ).rejects.toThrow(/transition refusée/)
  })

  // ── Fin d'effet (PUT) ────────────────────────────────────────────────────

  it("applique une fin d'effet (PUT) ; refuse dateFin<=dateDebut (422) ; refuse sur ligne terminale (409)", async () => {
    const siren = '910000111'
    await seedConsent(siren)
    const { id } = await publishOk({ siren, dateDebut: '20260111' })

    const putRes = await request(app.getHttpServer())
      .put(`/annuaire/lignes/${id}`)
      .send({ dateFin: '20260601' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(putRes.body).toEqual({ id, dateFin: '20260601' })
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      dateFin: '20260601',
    })

    await request(app.getHttpServer())
      .put(`/annuaire/lignes/${id}`)
      .send({ dateFin: '20260111' })
      .set('Authorization', `Bearer ${token}`)
      .expect(422)

    await directService.recordAck(tenantId, id, 'deposee')
    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204)

    await request(app.getHttpServer())
      .put(`/annuaire/lignes/${id}`)
      .send({ dateFin: '20270101' })
      .set('Authorization', `Bearer ${token}`)
      .expect(409)
  })

  // ── Isolation tenant (404 hors-tenant) ──────────────────────────────────

  it("isole les lignes par tenant : PUT/DELETE renvoient 404 pour un id d'un AUTRE tenant", async () => {
    const siren = '910000112'
    await seedConsent(siren)
    const { id } = await publishOk({ siren, dateDebut: '20260112' })

    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'ANN-PUBLISH-OTHER',
    )

    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)

    await request(app.getHttpServer())
      .put(`/annuaire/lignes/${id}`)
      .send({ dateFin: '20270101' })
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)

    // Le tenant propriétaire n'a subi aucune mutation fantôme.
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'published',
      dateFin: null,
    })
  })

  // ── Dual-auth ─────────────────────────────────────────────────────────────

  it('rejette une publication sans identifiants (401)', async () => {
    await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody({ siren: '910000113' }))
      .expect(401)
  })
})
