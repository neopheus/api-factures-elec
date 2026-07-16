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

// Endpoints de consultation annuaire + résolution de routage (Task 7, plan
// 2.4) — dual-auth (`TenantAuthGuard` : clé API OU session), isolation
// tenant (404 byte-identique, motif `EreportingController`/
// `LedgerController`), DTO hardening à la frontière HTTP (injections revue
// T2 #4/#5 + T5 #1, BINDING) : `date` validée AAAAMMJJ (422 sur garbage),
// `siret`/`routageId`/`suffixe` normalisés chaîne-vide→absent AVANT le
// repository. Résolution : maille la plus spécifique en vigueur, 404
// anti-fuite si non-adressable, 409 si indéterminée (ambiguïté), masquage
// NON cascadant vers une maille plus spécifique, et insensibilité à
// l'ordre d'insertion du miroir.

describe('annuaire consultation + résolution de routage (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: AnnuaireRepository
  let tenantId: string
  let token: string

  const SIREN = '900000001'
  const SIRET = '90000000100011'

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new AnnuaireRepository(new TenantContextService(appPool))
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ANN-CONSULT'))

    // Miroir : une Définition SIREN (large, plateforme '0001') et une
    // Définition SIREN_SIRET plus spécifique (plateforme '0002') sur le
    // MÊME SIREN, toutes deux en vigueur depuis 2026-01-01, sans fin.
    await repo.upsertDirectoryEntries(tenantId, [
      { siren: SIREN, nature: 'D', dateDebut: '20260101', plateforme: '0001' },
      {
        siren: SIREN,
        siret: SIRET,
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0002',
      },
    ])
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  // ── GET /annuaire/resolution — happy path ────────────────────────────────

  it('résout la maille la plus spécifique en vigueur (SIREN_SIRET prime sur SIREN)', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: SIREN, siret: SIRET, date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ plateforme: '0002' })
  })

  it('replie sur la Définition SIREN quand aucun siret n’est fourni', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: SIREN, date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ plateforme: '0001' })
  })

  // ── no-match : 404 anti-fuite ─────────────────────────────────────────────

  it('renvoie 404 (problem+json) quand aucune ligne n’est en vigueur à la date (hors période)', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: SIREN, siret: SIRET, date: '20250101' })
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:not-found')
  })

  it('renvoie 404 pour un SIREN totalement absent du miroir (jamais de 500/erreur non maîtrisée)', async () => {
    await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: '999999999', date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })

  // ── masquage non-cascadant (consumption layer, injection revue) ─────────

  it('un Masquage SIREN (large) ne masque PAS une Définition SIREN_SIRET plus spécifique (non-cascade)', async () => {
    const siren = '900000002'
    const siret = '90000000200011'
    await repo.upsertDirectoryEntries(tenantId, [
      { siren, nature: 'M', dateDebut: '20260101', plateforme: '9998' },
      {
        siren,
        siret,
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0003',
      },
    ])
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren, siret, date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ plateforme: '0003' })
  })

  it('un Masquage SIREN_SIRET (précis) replie sur la Définition SIREN plus large', async () => {
    const siren = '900000003'
    const siret = '90000000300011'
    await repo.upsertDirectoryEntries(tenantId, [
      { siren, nature: 'D', dateDebut: '20260101', plateforme: '0004' },
      {
        siren,
        siret,
        nature: 'M',
        dateDebut: '20260101',
        plateforme: '9998',
      },
    ])
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren, siret, date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ plateforme: '0004' })
  })

  // ── ambiguïté : 409 documenté, sans fuite de données ─────────────────────

  it('renvoie 409 (problem+json) quand deux mailles de même rang couvrent la cible sans départage possible', async () => {
    const siren = '900000004'
    const siret = '90000000400011'
    await repo.upsertDirectoryEntries(tenantId, [
      {
        siren,
        siret,
        routageId: 'ROUTE1',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0005',
      },
      {
        siren,
        suffixe: 'SUF1',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0006',
      },
    ])
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({
        siren,
        siret,
        routageId: 'ROUTE1',
        suffixe: 'SUF1',
        date: '20260615',
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(409)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:conflict')
    // Anti-fuite : la réponse ne révèle AUCUNE des deux plateformes concurrentes.
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('0005')
    expect(raw).not.toContain('0006')
  })

  // ── ordre-indépendance (deux tenants, ordres d'insertion inversés) ───────

  it('la résolution est insensible à l’ordre d’insertion du miroir (deux tenants, ordres inversés, même résultat)', async () => {
    const { tenantId: tenantOrderA, token: tokenOrderA } =
      await seedTenantWithKey(ownerPool, 'ANN-ORDER-A')
    const { tenantId: tenantOrderB, token: tokenOrderB } =
      await seedTenantWithKey(ownerPool, 'ANN-ORDER-B')
    const siren = '900000005'
    const siret = '90000000500011'
    const general = {
      siren,
      nature: 'D' as const,
      dateDebut: '20260101',
      plateforme: '0007',
    }
    const specific = {
      siren,
      siret,
      nature: 'D' as const,
      dateDebut: '20260101',
      plateforme: '0008',
    }
    // Tenant A : général PUIS spécifique. Tenant B : spécifique PUIS général.
    await repo.upsertDirectoryEntries(tenantOrderA, [general, specific])
    await repo.upsertDirectoryEntries(tenantOrderB, [specific, general])

    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .get('/annuaire/resolution')
        .query({ siren, siret, date: '20260615' })
        .set('Authorization', `Bearer ${tokenOrderA}`)
        .expect(200),
      request(app.getHttpServer())
        .get('/annuaire/resolution')
        .query({ siren, siret, date: '20260615' })
        .set('Authorization', `Bearer ${tokenOrderB}`)
        .expect(200),
    ])
    expect(resA.body).toEqual({ plateforme: '0008' })
    expect(resB.body).toEqual({ plateforme: '0008' })
  })

  // ── DTO hardening : dateYmd 422, siren 422, ''→null normalisation ────────

  it('422 sur une date malformée (mauvais format, mauvaise largeur, mois/jour hors bornes)', async () => {
    for (const badDate of ['2026-06-15', '202606', '20261301', '20260632']) {
      const res = await request(app.getHttpServer())
        .get('/annuaire/resolution')
        .query({ siren: SIREN, siret: SIRET, date: badDate })
        .set('Authorization', `Bearer ${token}`)
        .expect(422)
      expect(res.body.type).toBe('urn:factelec:problem:validation-error')
    }
  })

  it('422 sur un SIREN malformé', async () => {
    await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: 'abc', date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
  })

  it('normalise siret="" comme ABSENT (traité comme la maille SIREN, jamais comme une chaîne vide littérale)', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: SIREN, siret: '', date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    // Identique au comportement "siret absent" (repli SIREN, plateforme '0001') —
    // PAS un 422, PAS un 404 lié à une maille SIREN_SIRET("") inexistante.
    expect(res.body).toEqual({ plateforme: '0001' })
  })

  it('normalise routageId="" et suffixe="" comme ABSENTS (même résultat qu’en leur absence totale)', async () => {
    const withEmpty = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({
        siren: SIREN,
        siret: SIRET,
        routageId: '',
        suffixe: '',
        date: '20260615',
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const withoutParams = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: SIREN, siret: SIRET, date: '20260615' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(withEmpty.body).toEqual(withoutParams.body)
  })

  // ── GET /annuaire/lignes ──────────────────────────────────────────────────

  it('GET /annuaire/lignes renvoie les lignes du miroir pour un SIREN', async () => {
    const res = await request(app.getHttpServer())
      .get('/annuaire/lignes')
      .query({ siren: SIREN })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.lignes).toHaveLength(2)
    expect(
      res.body.lignes.map((l: { plateforme: string }) => l.plateforme).sort(),
    ).toEqual(['0001', '0002'])
  })

  it('422 sur GET /annuaire/lignes avec un SIREN malformé', async () => {
    await request(app.getHttpServer())
      .get('/annuaire/lignes')
      .query({ siren: '123' })
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
  })

  // ── isolation tenant : 404/liste vide byte-identiques ────────────────────

  it('isole le miroir par tenant : résolution 404 byte-identique pour un autre tenant sur la même maille/date', async () => {
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'ANN-CONSULT-OTHER',
    )
    const [ownRes, otherRes] = await Promise.all([
      request(app.getHttpServer())
        .get('/annuaire/resolution')
        .query({ siren: '999999998', date: '20260615' })
        .set('Authorization', `Bearer ${token}`)
        .expect(404),
      request(app.getHttpServer())
        .get('/annuaire/resolution')
        .query({ siren: SIREN, siret: SIRET, date: '20260615' })
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404),
    ])
    expect(ownRes.body).toEqual(otherRes.body)
  })

  it('isole le miroir par tenant : /annuaire/lignes ne montre jamais les lignes d’un autre tenant', async () => {
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'ANN-LIGNES-OTHER',
    )
    const res = await request(app.getHttpServer())
      .get('/annuaire/lignes')
      .query({ siren: SIREN })
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200)
    expect(res.body.lignes).toEqual([])
  })

  // ── dual-auth ─────────────────────────────────────────────────────────────

  it('dual-auth : une session du même tenant obtient aussi 200 (pas seulement la clé API)', async () => {
    const email = 'annuaire-session@example.com'
    const session = await signupSession(app, {
      email,
      password: 'a-strong-passphrase-123',
      organizationName: 'ANN-session',
      siren: null,
    })
    const sessionTenantId = (
      await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
        email,
      ])
    ).rows[0].tenant_id
    await repo.upsertDirectoryEntries(sessionTenantId, [
      {
        siren: '900000006',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0009',
      },
    ])

    const res = await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: '900000006', date: '20260615' })
      .set('Cookie', session.cookie)
      .expect(200)
    expect(res.body).toEqual({ plateforme: '0009' })
  })

  it('rejette un accès sans identifiants (401)', async () => {
    await request(app.getHttpServer())
      .get('/annuaire/resolution')
      .query({ siren: SIREN, date: '20260615' })
      .expect(401)
  })
})
