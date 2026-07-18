import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Scellement structurel du consentement à la création (D3, Task 2, plan
// 3.5) — endpoint HTTP réel (`createTestApp`, port RÉEL
// `LocalFilesystemConsentStore` sous `CONSENT_LOCAL_DIR` hermétique, motif
// annuaire-publication.e2e.test.ts) : AUCUN worker, suite LIGHT. Le gate de
// consentement lui-même (couverture/révocation, chemins `consentId`/
// auto-découverte, 422 sans consentement) reste couvert par
// annuaire-publication.e2e.test.ts, INCHANGÉ (GARDE D3) — cette suite porte
// UNIQUEMENT le scellement de la branche `proof`.
const SEAL_REF_RE = /^[0-9a-f]{64}$/

describe('annuaire consentement : scellement structurel à la création (e2e, LIGHT)', () => {
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
    ;({ tenantId, token } = await seedTenantWithKey(
      ownerPool,
      'ANN-CONSENT-SEAL',
    ))
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  function ligneBody(overrides: Record<string, unknown> = {}) {
    return {
      siren: '920000000',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
      ...overrides,
    }
  }

  async function publishOk(
    overrides: Record<string, unknown>,
    authToken = token,
  ) {
    const res = await request(app.getHttpServer())
      .post('/annuaire/lignes')
      .send(ligneBody(overrides))
      .set('Authorization', `Bearer ${authToken}`)
      .expect(201)
    return res.body as { id: string; status: string }
  }

  async function evidenceRefOf(
    forTenantId: string,
    ligneId: string,
  ): Promise<string> {
    const ligne = await repo.findLigne(forTenantId, ligneId)
    if (!ligne) throw new Error('ligne introuvable')
    const row = await ownerPool.query(
      'SELECT evidence_ref FROM annuaire_consents WHERE id = $1',
      [ligne.consentId],
    )
    return row.rows[0].evidence_ref as string
  }

  function sealPathOf(forTenantId: string, evidenceRef: string): string {
    return join(
      process.env.CONSENT_LOCAL_DIR as string,
      forTenantId,
      `${evidenceRef}.seal`,
    )
  }

  it('POST /annuaire/lignes avec proof → 201, annuaire_consents.evidence_ref est un sha256 (64 hex), fichier de sceau écrit write-once', async () => {
    const siren = '920000101'
    const { id } = await publishOk({
      siren,
      dateDebut: '20260101',
      proof: {
        consentType: 'mandat',
        signerIdentity: 'Signataire Sceau',
        evidenceRef: 'EVID-CLIENT-BRUTE-1',
        obtainedAt: '2026-01-01T00:00:00.000Z',
      },
    })

    const evidenceRef = await evidenceRefOf(tenantId, id)
    expect(evidenceRef).toMatch(SEAL_REF_RE)
    // La chaîne evidenceRef CLIENT brute n'est jamais persistée telle
    // quelle : evidence_ref stocke le SCEAU (D3).
    expect(evidenceRef).not.toBe('EVID-CLIENT-BRUTE-1')

    const sealPath = sealPathOf(tenantId, evidenceRef)
    const stats = await stat(sealPath)
    expect(stats.isFile()).toBe(true)
    // Write-once (WORM, chmod 0o444) : une réécriture directe échoue.
    await expect(
      writeFile(sealPath, 'altered', { encoding: 'utf8' }),
    ).rejects.toThrow(/EACCES|EPERM/)
  })

  it('re-publier la MÊME preuve (même maille) → sceau idempotent (alreadyExisted), evidence_ref identique', async () => {
    const siren = '920000102'
    const proof = {
      consentType: 'mandat',
      signerIdentity: 'Signataire Rejeu',
      evidenceRef: 'EVID-CLIENT-BRUTE-2',
      obtainedAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await publishOk({ siren, dateDebut: '20260102', proof })
    const second = await publishOk({ siren, dateDebut: '20260103', proof })

    const evidenceRef1 = await evidenceRefOf(tenantId, first.id)
    const evidenceRef2 = await evidenceRefOf(tenantId, second.id)
    expect(evidenceRef2).toBe(evidenceRef1)
  })

  it('publier avec consentId d’un consentement déjà scellé → 201 sans nouveau scellement (gate couverture/révocation)', async () => {
    const siren = '920000103'
    const proof = {
      consentType: 'mandat',
      signerIdentity: 'Signataire Réutilisé',
      evidenceRef: 'EVID-CLIENT-BRUTE-3',
      obtainedAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await publishOk({ siren, dateDebut: '20260104', proof })
    const firstLigne = await repo.findLigne(tenantId, first.id)
    const consentId = firstLigne?.consentId as string

    const countBefore = await ownerPool.query(
      'SELECT count(*)::int AS n FROM annuaire_consents WHERE tenant_id = $1 AND siren = $2',
      [tenantId, siren],
    )

    const second = await publishOk({
      siren,
      dateDebut: '20260105',
      consentId,
    })
    expect(second.status).toBe('published')

    // Aucun nouveau consentement (donc aucun nouveau scellement) : le chemin
    // `consentId` réutilise le consentement déjà scellé, seule la ligne est
    // nouvelle.
    const countAfter = await ownerPool.query(
      'SELECT count(*)::int AS n FROM annuaire_consents WHERE tenant_id = $1 AND siren = $2',
      [tenantId, siren],
    )
    expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n)

    const secondLigne = await repo.findLigne(tenantId, second.id)
    expect(secondLigne?.consentId).toBe(consentId)
  })

  it('isolation multi-tenant : le sceau et le consentement restent sous le bon tenant (RLS)', async () => {
    const siren = '920000104'
    const proof = {
      consentType: 'mandat',
      signerIdentity: 'Signataire Isolation',
      evidenceRef: 'EVID-CLIENT-BRUTE-4',
      obtainedAt: '2026-01-01T00:00:00.000Z',
    }
    const { tenantId: otherTenantId, token: otherToken } =
      await seedTenantWithKey(ownerPool, 'ANN-CONSENT-SEAL-OTHER')

    const resA = await publishOk({ siren, dateDebut: '20260106', proof })
    const resB = await publishOk(
      { siren, dateDebut: '20260106', proof },
      otherToken,
    )

    const evidenceRefA = await evidenceRefOf(tenantId, resA.id)
    const evidenceRefB = await evidenceRefOf(otherTenantId, resB.id)

    // tenantId fait partie de la forme canonique hachée (F1, task-1-report)
    // : même preuve, tenants distincts → sceaux distincts.
    expect(evidenceRefA).not.toBe(evidenceRefB)

    await expect(
      stat(sealPathOf(tenantId, evidenceRefA)),
    ).resolves.toMatchObject({})
    await expect(
      stat(sealPathOf(otherTenantId, evidenceRefB)),
    ).resolves.toMatchObject({})

    // Le sceau du tenant A n'existe PAS sous le shard du tenant B, et
    // réciproquement (cloisonnement filesystem par tenant).
    await expect(stat(sealPathOf(otherTenantId, evidenceRefA))).rejects.toThrow(
      /ENOENT/,
    )
    await expect(stat(sealPathOf(tenantId, evidenceRefB))).rejects.toThrow(
      /ENOENT/,
    )
  })
})
