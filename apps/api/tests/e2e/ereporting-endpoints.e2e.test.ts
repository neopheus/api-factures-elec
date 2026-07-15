import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { EreportingRepository } from '../../src/ereporting/ereporting.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { signupSession } from './helpers/session.js'

// Endpoints de consultation e-reporting (Task 9, plan 2.3) — dual-auth
// (TenantAuthGuard : clé API OU session), isolation tenant (404
// byte-identique, motif LedgerController), liste SANS XML, `:id/xml` en
// text/xml, `:id/events` avec actor+fromStatus, `rejectOrigin` local/ppf
// (injection T8, désambiguïsation rejet LOCAL vs PPF 301), et codes DGFiP
// (300/301) EXPOSÉS UNIQUEMENT quand ils existent (injection T4 #3 —
// `prepared`/`transmitted` n'ont jamais de code inventé).

describe('e-reporting consultation endpoints (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: EreportingRepository
  let tenantId: string
  let token: string
  let declarantId: string

  let preparedId: string
  let transmittedId: string
  let deposeeId: string
  let ppfRejectedId: string
  let localRejectedId: string

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    repo = new EreportingRepository(new TenantContextService(appPool))
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'EREP-EP'))
    declarantId = (
      await ownerPool.query(
        `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
         VALUES ($1, '444555666', 'Déclarant EP', 'SE', 'simplifie') RETURNING id`,
        [tenantId],
      )
    ).rows[0].id

    // prepared (jamais transmise) : status interne, dgfipCode=null.
    ;({ id: preparedId } = await repo.insertTransmission(tenantId, {
      declarantId,
      transmissionRef: 'TT-EP-PREPARED',
      type: 'IN',
      fluxKind: 'transactions',
      periodStart: '20260701',
      periodEnd: '20260731',
      invoiceCount: 0,
      xml: '<Report>Prepared</Report>',
    }))

    // transmitted (jamais acquittée) : status interne, dgfipCode=null.
    const transmittedInsert = await repo.insertTransmission(tenantId, {
      declarantId,
      transmissionRef: 'TT-EP-TRANSMITTED',
      type: 'IN',
      fluxKind: 'transactions',
      periodStart: '20260801',
      periodEnd: '20260831',
      invoiceCount: 2,
      xml: '<Report>Transmitted</Report>',
    })
    transmittedId = transmittedInsert.id
    await repo.markTransmitted(tenantId, transmittedId, 'TRACK-EP-TRANSMITTED')

    // deposee (300, acquittée PPF).
    const deposeeInsert = await repo.insertTransmission(tenantId, {
      declarantId,
      transmissionRef: 'TT-EP-DEPOSEE',
      type: 'IN',
      fluxKind: 'transactions',
      periodStart: '20260901',
      periodEnd: '20260930',
      invoiceCount: 5,
      xml: '<Report>Deposee</Report>',
    })
    deposeeId = deposeeInsert.id
    await repo.markTransmitted(tenantId, deposeeId, 'TRACK-EP-DEPOSEE')
    await repo.appendStatusEvent(
      tenantId,
      deposeeId,
      'transmitted',
      'deposee',
      'ppf',
    )

    // rejetee PPF (301, from='transmitted', actor='ppf') : rejectOrigin='ppf'.
    const ppfRejectedInsert = await repo.insertTransmission(tenantId, {
      declarantId,
      transmissionRef: 'TT-EP-REJ-PPF',
      type: 'IN',
      fluxKind: 'transactions',
      periodStart: '20261001',
      periodEnd: '20261031',
      invoiceCount: 1,
      xml: '<Report>RejPpf</Report>',
    })
    ppfRejectedId = ppfRejectedInsert.id
    await repo.markTransmitted(tenantId, ppfRejectedId, 'TRACK-EP-REJ-PPF')
    await repo.appendStatusEvent(
      tenantId,
      ppfRejectedId,
      'transmitted',
      'rejetee',
      'ppf',
      'REJ_UNI',
    )

    // rejetee LOCALE (né rejetee, from=null, actor='platform') :
    // rejectOrigin='local'.
    const localRejectedInsert = await repo.insertTransmission(tenantId, {
      declarantId,
      transmissionRef: 'TT-EP-REJ-LOCAL',
      type: 'IN',
      fluxKind: 'transactions',
      periodStart: '20261101',
      periodEnd: '20261130',
      invoiceCount: 0,
      xml: '<Report>Invalid</Report>',
      rejectMotif: 'REJ_SEMAN',
    })
    localRejectedId = localRejectedInsert.id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await db.stop()
  })

  // ── GET /ereporting/transmissions ──────────────────────────────────────

  it('liste les transmissions SANS le XML, avec code DGFiP uniquement quand il existe, et rejectOrigin local/ppf distinguables', async () => {
    const res = await request(app.getHttpServer())
      .get('/ereporting/transmissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const byRef = new Map(
      (
        res.body.transmissions as Array<{
          transmissionRef: string
          [k: string]: unknown
        }>
      ).map((t) => [t.transmissionRef, t]),
    )
    expect(byRef.size).toBe(5)
    for (const t of byRef.values()) {
      expect(t).not.toHaveProperty('xml')
    }

    expect(byRef.get('TT-EP-PREPARED')).toMatchObject({
      status: 'prepared',
      dgfipCode: null,
      rejectOrigin: null,
    })
    expect(byRef.get('TT-EP-TRANSMITTED')).toMatchObject({
      status: 'transmitted',
      dgfipCode: null,
      rejectOrigin: null,
    })
    expect(byRef.get('TT-EP-DEPOSEE')).toMatchObject({
      status: 'deposee',
      dgfipCode: 300,
      rejectOrigin: null,
    })
    expect(byRef.get('TT-EP-REJ-PPF')).toMatchObject({
      status: 'rejetee',
      dgfipCode: 301,
      rejectOrigin: 'ppf',
    })
    expect(byRef.get('TT-EP-REJ-LOCAL')).toMatchObject({
      status: 'rejetee',
      dgfipCode: 301,
      rejectOrigin: 'local',
    })
  })

  it('dual-auth : une session du même tenant obtient aussi 200 (pas seulement la clé API)', async () => {
    const email = 'ereporting-session@example.com'
    const session = await signupSession(app, {
      email,
      password: 'a-strong-passphrase-123',
      organizationName: 'EREP-session',
      siren: null,
    })
    const sessionTenantId = (
      await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
        email,
      ])
    ).rows[0].tenant_id

    // Facture dans SON PROPRE tenant (signup en crée un nouveau) : on y sème
    // une transmission pour vérifier le dual-auth sans mélanger les tenants.
    const sessionDeclarantId = (
      await ownerPool.query(
        `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
         VALUES ($1, '777888999', 'Déclarant Session', 'SE', 'simplifie') RETURNING id`,
        [sessionTenantId],
      )
    ).rows[0].id
    await repo.insertTransmission(sessionTenantId, {
      declarantId: sessionDeclarantId,
      transmissionRef: 'TT-EP-SESSION',
      type: 'IN',
      fluxKind: 'transactions',
      periodStart: '20260701',
      periodEnd: '20260731',
      invoiceCount: 0,
      xml: '<Report>Session</Report>',
    })

    const res = await request(app.getHttpServer())
      .get('/ereporting/transmissions')
      .set('Cookie', session.cookie)
      .expect(200)
    expect(
      res.body.transmissions.map(
        (t: { transmissionRef: string }) => t.transmissionRef,
      ),
    ).toContain('TT-EP-SESSION')
  })

  // ── GET /ereporting/transmissions/:id/xml ──────────────────────────────

  it(':id/xml renvoie le XML en text/xml', async () => {
    const res = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${deposeeId}/xml`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.headers['content-type']).toContain('text/xml')
    expect(res.text).toBe('<Report>Deposee</Report>')
  })

  it(':id/xml renvoie 404 byte-identique pour un id inconnu ET pour un id d’un autre tenant', async () => {
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'EREP-EP-OTHER',
    )
    const [unknown, otherTenant] = await Promise.all([
      request(app.getHttpServer())
        .get(
          '/ereporting/transmissions/00000000-0000-0000-0000-000000000000/xml',
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(404),
      request(app.getHttpServer())
        .get(`/ereporting/transmissions/${deposeeId}/xml`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404),
    ])
    expect(unknown.body).toEqual(otherTenant.body)
    expect(unknown.headers['content-type']).toContain(
      'application/problem+json',
    )
  })

  // ── GET /ereporting/transmissions/:id/events ───────────────────────────

  it(':id/events expose actor et fromStatus, et distingue un rejet PPF (from=transmitted, actor=ppf)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${ppfRejectedId}/events`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.events).toHaveLength(3)
    expect(
      res.body.events.map((e: { toStatus: string }) => e.toStatus),
    ).toEqual(['prepared', 'transmitted', 'rejetee'])
    const rejectionEvent = res.body.events.at(-1)
    expect(rejectionEvent).toMatchObject({
      fromStatus: 'transmitted',
      toStatus: 'rejetee',
      motif: 'REJ_UNI',
      actor: 'ppf',
    })
  })

  it(':id/events distingue un rejet LOCAL né rejetee (from=null, actor=platform)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${localRejectedId}/events`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.events).toHaveLength(1)
    expect(res.body.events[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'rejetee',
      motif: 'REJ_SEMAN',
      actor: 'platform',
    })
  })

  it(':id/events renvoie 404 pour un id d’un autre tenant (anti-fuite)', async () => {
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'EREP-EP-EVENTS-OTHER',
    )
    await request(app.getHttpServer())
      .get(`/ereporting/transmissions/${preparedId}/events`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)
  })

  it('la liste isole par tenant : un autre tenant ne voit aucune transmission de celui-ci', async () => {
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'EREP-EP-LIST-OTHER',
    )
    const res = await request(app.getHttpServer())
      .get('/ereporting/transmissions')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200)
    expect(res.body.transmissions).toEqual([])
  })
})
