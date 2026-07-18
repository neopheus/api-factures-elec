import type { INestApplication } from '@nestjs/common'
import { Queue } from 'bullmq'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { EREPORTING_GENERATION_QUEUE } from '../../src/queue/queue.constants.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { extractCookie, signupSession } from './helpers/session.js'

// Endpoint opérateur de retransmission RE (plan 3.4, Task 2, D1/D2/D4) —
// fichier LIGHT (nit revue du plan, BINDING) : vérifie l'ENFILEMENT (via
// l'API Queue/getJob) et les codes HTTP des garde-fous SEULEMENT — n'importe
// JAMAIS `createTestWorker` (le verrou d'architecture,
// tests/unit/heavy-suites.arch.test.ts, exige une allowlist HEAVY_TESTS
// stricte : ce fichier ne consomme aucun job, donc n'y figure pas). Le
// bout-en-bout endpoint→worker→transmission RE est couvert par le fichier
// HEAVY existant (ereporting-retransmission.e2e.test.ts, Task 1) — étendu
// avec un 5ᵉ `it()` plutôt qu'un nouveau fichier (choix le plus simple : ce
// fichier a déjà Postgres+Redis+worker en place).
describe('POST /ereporting/retransmissions — enfilement + garde-fous (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let token: string
  let tenantId: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ownerPool.on('error', () => {})
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ERE-RETX'))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  async function makeDeclarant(tid: string, siren: string): Promise<string> {
    const d = await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
       VALUES ($1, $2, 'Déclarant e2e', 'SE', 'reel_normal_mensuel') RETURNING id`,
      [tid, siren],
    )
    return d.rows[0].id
  }

  async function seedInitialTransmission(
    tid: string,
    declarantId: string,
    fluxKind: 'transactions' | 'payments',
    periodStart: string,
    periodEnd: string,
    status: 'prepared' | 'transmitted' = 'transmitted',
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO ereporting_transmissions
         (tenant_id, declarant_id, transmission_ref, type, flux_kind, period_start, period_end, status, invoice_count)
       VALUES ($1, $2, $3, 'IN', $4, $5, $6, $7, 0)`,
      [
        tid,
        declarantId,
        `ER-${declarantId.slice(0, 8)}-${periodStart}-IN`,
        fluxKind,
        periodStart,
        periodEnd,
        status,
      ],
    )
  }

  const post = (body: object) =>
    request(app.getHttpServer())
      .post('/ereporting/retransmissions')
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  it('202 nominal : enfile un job RE, {jobId, transmissionRef}', async () => {
    const declarantId = await makeDeclarant(tenantId, '711111111')
    await seedInitialTransmission(
      tenantId,
      declarantId,
      'transactions',
      '20260901',
      '20260910',
    )

    const res = await post({
      declarantId,
      fluxKind: 'transactions',
      periodStart: '20260901',
    }).expect(202)

    expect(res.body).toEqual({
      jobId: `${declarantId}-transactions-20260901-RE-0`,
      transmissionRef: `ER-${declarantId.slice(0, 8)}-20260901-RE-0`,
    })

    const queue = new Queue(EREPORTING_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.getJob(res.body.jobId)
      expect(job).not.toBeNull()
      expect(job?.data).toMatchObject({
        tenantId,
        declarantId,
        siren: '711111111',
        role: 'SE',
        fluxKind: 'transactions',
        periodStart: '20260901',
        // periodEnd REPRIS DE L'IN (jamais du client, D4) — le client n'en a
        // fourni AUCUN dans le body posté ci-dessus.
        periodEnd: '20260910',
        type: 'RE',
        reSeq: 0,
      })
    } finally {
      await queue.close()
    }
  })

  it('anti-double-clic : deux appels rapprochés (même reSeq) → même jobId, un seul job enfilé', async () => {
    const declarantId = await makeDeclarant(tenantId, '722222222')
    await seedInitialTransmission(
      tenantId,
      declarantId,
      'transactions',
      '20260901',
      '20260910',
    )

    const [r1, r2] = await Promise.all([
      post({ declarantId, fluxKind: 'transactions', periodStart: '20260901' }),
      post({ declarantId, fluxKind: 'transactions', periodStart: '20260901' }),
    ])
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    expect(r1.body.jobId).toBe(r2.body.jobId)
    expect(r1.body.transmissionRef).toBe(r2.body.transmissionRef)

    const queue = new Queue(EREPORTING_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      // BullMQ déduplique par jobId : un SEUL job existe sous cette clé —
      // preuve du collapse (couche 2 de la défense D3), pas deux jobs.
      const job = await queue.getJob(r1.body.jobId)
      expect(job).not.toBeNull()
    } finally {
      await queue.close()
    }
  })

  it('404 byte-identique : déclarant inconnu OU d’un autre tenant (anti-fuite), rien enfilé', async () => {
    const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'
    const unknown = await post({
      declarantId: UNKNOWN_ID,
      fluxKind: 'transactions',
      periodStart: '20260901',
    }).expect(404)

    const declarantId = await makeDeclarant(tenantId, '733333333')
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'ERE-RETX-OTHER',
    )
    const crossTenant = await request(app.getHttpServer())
      .post('/ereporting/retransmissions')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        declarantId,
        fluxKind: 'transactions',
        periodStart: '20260901',
      })
      .expect(404)

    expect(unknown.body).toEqual(crossTenant.body)
    expect(unknown.headers['content-type']).toContain(
      'application/problem+json',
    )
  })

  it('409 : aucun IN préalable pour cette période', async () => {
    const declarantId = await makeDeclarant(tenantId, '744444444')
    const res = await post({
      declarantId,
      fluxKind: 'transactions',
      periodStart: '20260901',
    }).expect(409)
    expect(res.body.type).toBe('urn:factelec:problem:conflict')
  })

  it("409 : IN encore en statut 'prepared' — MÊME CORPS que l'absence d'IN (amendement M-D4-1)", async () => {
    const declarantNoIn = await makeDeclarant(tenantId, '755555555')
    const noIn = await post({
      declarantId: declarantNoIn,
      fluxKind: 'transactions',
      periodStart: '20260901',
    }).expect(409)

    const declarantPrepared = await makeDeclarant(tenantId, '766666666')
    await seedInitialTransmission(
      tenantId,
      declarantPrepared,
      'transactions',
      '20260901',
      '20260910',
      'prepared',
    )
    const prepared = await post({
      declarantId: declarantPrepared,
      fluxKind: 'transactions',
      periodStart: '20260901',
    }).expect(409)

    expect(prepared.body).toEqual(noIn.body)
  })

  it('422 : declarantId malformé (non-UUID, zod)', async () => {
    const res = await post({
      declarantId: 'not-a-uuid',
      fluxKind: 'transactions',
      periodStart: '20260901',
    }).expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
  })

  it('401 : sans authentification', async () => {
    await request(app.getHttpServer())
      .post('/ereporting/retransmissions')
      .send({
        declarantId: '00000000-0000-0000-0000-000000000000',
        fluxKind: 'transactions',
        periodStart: '20260901',
      })
      .expect(401)
  })

  it('403 : mutation de session sans le header CSRF (motif payments)', async () => {
    const session = await signupSession(app, {
      email: 'ere-retx-csrf@example.com',
      password: 'a-strong-password-1',
      organizationName: 'ERE-RETX-CSRF',
    })
    await request(app.getHttpServer())
      .post('/ereporting/retransmissions')
      .set('Cookie', session.cookie)
      .send({
        declarantId: '00000000-0000-0000-0000-000000000000',
        fluxKind: 'transactions',
        periodStart: '20260901',
      })
      .expect(403)
  })

  it('403 : un rôle viewer ne peut pas déclencher de retransmission', async () => {
    const signup = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({
        email: 'ere-retx-owner@example.com',
        password: 'a-strong-password-1',
        organizationName: 'ERE-RETX-VIEWER',
      })
      .expect(201)
    const viewerTenantId = signup.body.user.tenantId as string
    await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'ere-retx-viewer@example.com', $2, 'viewer')",
      [viewerTenantId, await hashPassword('a-strong-password-1')],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'ere-retx-viewer@example.com',
        password: 'a-strong-password-1',
      })
      .expect(200)
    const vCookie = login.headers['set-cookie'] as unknown as string[]
    await request(app.getHttpServer())
      .post('/ereporting/retransmissions')
      .set('Cookie', vCookie)
      .set('X-CSRF-Token', extractCookie(vCookie, 'factelec_csrf'))
      .send({
        declarantId: '00000000-0000-0000-0000-000000000000',
        fluxKind: 'transactions',
        periodStart: '20260901',
      })
      .expect(403)
  })
})
