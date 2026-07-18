import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { hashPassword } from '../../src/auth/password.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { extractCookie } from './helpers/session.js'

// Task 4bis (plan 3.5) : correctif de la faille PRÉ-EXISTANTE héritée de 2.4
// Tasks 7/8, découverte lors de l'extension M1 du verrou d'architecture
// (task-4-report.md, section « Découverte ») — `POST/PUT/DELETE
// /annuaire/lignes` composaient `TenantAuthGuard` SEUL : une session
// authentifiée de N'IMPORTE QUEL rôle (viewer inclus) pouvait
// publier/modifier/masquer une ligne d'annuaire — impactant le routage
// réglementaire des factures — SANS jeton CSRF. LIGHT (Postgres réel seul,
// motif EXACT `invoice-routing-resolve.e2e.test.ts`) : chaque scénario mute
// (ou tente de muter) une ligne RÉELLE du MÊME tenant que la session testée
// (utilisateurs `viewer`/`owner` insérés directement dans `users` pour le
// tenant seedé par clé API — `authenticate_user`/`login` ne distinguent pas
// signup vs insertion directe), preuve la plus réaliste du risque décrit
// ci-dessus (pas un id inerte d'un autre tenant qui court-circuiterait sur
// autre chose que le guard visé).
//
// « clé API → inchangé OK » : déjà PROUVÉ par les 14 tests existants
// d'`annuaire-publication.e2e.test.ts` (tous authentifient via
// `Bearer ${token}`, motif de clé API) — pas de test dédié redondant ici.

const PASSWORD = 'a-strong-password-1'

let db: TestDb
let ownerPool: pg.Pool
let appPool: pg.Pool
let app: INestApplication
let repo: AnnuaireRepository
let tenantId: string
let token: string

beforeAll(async () => {
  db = await startTestDb()
  ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
  appPool = new pg.Pool({ connectionString: db.appUrl })
  ownerPool.on('error', () => {})
  appPool.on('error', () => {})
  repo = new AnnuaireRepository(new TenantContextService(appPool))
  ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ANN-GUARDS'))
  app = await createTestApp(db.appUrl)
})

afterAll(async () => {
  await appPool.end()
  await ownerPool.end()
  await app.close()
  await db.stop()
})

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

async function seedLigne(siren: string, dateDebut: string): Promise<string> {
  await repo.insertConsent(tenantId, {
    siren,
    consentType: 'mandat',
    signerIdentity: 'Signataire E2E',
    evidenceRef: 'EVID-GUARDS',
    obtainedAt: new Date('2026-01-01T00:00:00Z'),
  })
  const res = await request(app.getHttpServer())
    .post('/annuaire/lignes')
    .send({ siren, nature: 'D', dateDebut, plateforme: '0001' })
    .set('Authorization', `Bearer ${token}`)
    .expect(201)
  return res.body.id as string
}

// `mask` (DELETE) n'accepte que le statut `deposee` (A-DEADLOCK, D6) : sans
// ce pré-requis, une session non autorisée buterait sur le 409 métier AVANT
// même d'atteindre le garde visé par ces tests, masquant un fail-open
// éventuel derrière un refus légitime. Statut forcé directement en base
// (motif `UPDATE canonical` d'`invoice-routing-resolve.e2e.test.ts`) : seul
// moyen déterministe d'atteindre `deposee` en LIGHT (acquittement PPF réel
// hors périmètre de ce fichier de garde).
async function seedDeposeeLigne(
  siren: string,
  dateDebut: string,
): Promise<string> {
  const id = await seedLigne(siren, dateDebut)
  await ownerPool.query(
    "UPDATE annuaire_lignes SET status = 'deposee' WHERE id = $1",
    [id],
  )
  return id
}

describe('annuaire.controller — garde dual-auth des mutations (e2e, Postgres réel, LIGHT)', () => {
  // ── POST /annuaire/lignes ────────────────────────────────────────────────

  it('POST /annuaire/lignes : 403 pour une session viewer (même avec CSRF valide)', async () => {
    const cookie = await sessionCookie('ann-post-viewer@example.com', 'viewer')
    await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send({
        siren: '910000200',
        nature: 'D',
        dateDebut: '20260201',
        plateforme: '0001',
      })
      .set('Cookie', cookie)
      .set('X-CSRF-Token', extractCookie(cookie, 'factelec_csrf'))
      .expect(403)
    const lignes = await repo.listLignes(tenantId)
    expect(lignes.some((l) => l.siren === '910000200')).toBe(false)
  })

  it('POST /annuaire/lignes : 403 pour une session owner SANS X-CSRF-Token', async () => {
    const cookie = await sessionCookie('ann-post-nocsrf@example.com', 'owner')
    await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send({
        siren: '910000201',
        nature: 'D',
        dateDebut: '20260202',
        plateforme: '0001',
      })
      .set('Cookie', cookie)
      .expect(403)
    const lignes = await repo.listLignes(tenantId)
    expect(lignes.some((l) => l.siren === '910000201')).toBe(false)
  })

  // ── PUT /annuaire/lignes/:id ─────────────────────────────────────────────

  it('PUT /annuaire/lignes/:id : 403 pour une session viewer (même avec CSRF valide), ligne inchangée', async () => {
    const id = await seedLigne('910000202', '20260203')
    const cookie = await sessionCookie('ann-put-viewer@example.com', 'viewer')
    await request(app.getHttpServer())
      .put(`/annuaire/lignes/${id}`)
      .send({ dateFin: '20260601' })
      .set('Cookie', cookie)
      .set('X-CSRF-Token', extractCookie(cookie, 'factelec_csrf'))
      .expect(403)
    expect(await repo.findLigne(tenantId, id)).toMatchObject({ dateFin: null })
  })

  it('PUT /annuaire/lignes/:id : 403 pour une session owner SANS X-CSRF-Token, ligne inchangée', async () => {
    const id = await seedLigne('910000203', '20260204')
    const cookie = await sessionCookie('ann-put-nocsrf@example.com', 'owner')
    await request(app.getHttpServer())
      .put(`/annuaire/lignes/${id}`)
      .send({ dateFin: '20260601' })
      .set('Cookie', cookie)
      .expect(403)
    expect(await repo.findLigne(tenantId, id)).toMatchObject({ dateFin: null })
  })

  // ── DELETE /annuaire/lignes/:id ──────────────────────────────────────────

  it('DELETE /annuaire/lignes/:id : 403 pour une session viewer (même avec CSRF valide), ligne inchangée', async () => {
    const id = await seedDeposeeLigne('910000204', '20260205')
    const cookie = await sessionCookie(
      'ann-delete-viewer@example.com',
      'viewer',
    )
    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${id}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', extractCookie(cookie, 'factelec_csrf'))
      .expect(403)
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'deposee',
    })
  })

  it('DELETE /annuaire/lignes/:id : 403 pour une session owner SANS X-CSRF-Token, ligne inchangée', async () => {
    const id = await seedDeposeeLigne('910000205', '20260206')
    const cookie = await sessionCookie('ann-delete-nocsrf@example.com', 'owner')
    await request(app.getHttpServer())
      .delete(`/annuaire/lignes/${id}`)
      .set('Cookie', cookie)
      .expect(403)
    expect(await repo.findLigne(tenantId, id)).toMatchObject({
      status: 'deposee',
    })
  })
})
