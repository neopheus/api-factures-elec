import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateApiKey } from '../../src/auth/api-key.js'
import { hashPassword } from '../../src/auth/password.js'
import { BillingRepository } from '../../src/billing/billing.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { extractCookie, signupSession } from './helpers/session.js'

// Task 3 (spec §3, phase 5 it.2) : liste tenants enrichie (SD 1
// find_admin_tenant_stats) + détail per-tenant RLS-scopé (GET
// /admin/tenants/:id) — suite LIGHT (Postgres seul, motif admin.e2e.test.ts :
// aucun Worker/Redis nécessaire, ni la liste ni le détail ne touchent
// BullMQ). Auth admin calquée sur admin.e2e.test.ts (login password seul —
// NOTA la Task 7 durcira avec TOTP, non traité ici).
describe('admin supervision — liste enrichie + détail (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let billingRepo: BillingRepository
  let invoicesRepo: InvoicesRepository
  let billedTenantId: string
  let plainTenantId: string

  function invoiceInput(number: string): InvoiceInput {
    return {
      number,
      issueDate: '2026-07-16',
      typeCode: '380',
      currency: 'EUR',
      businessProcessType: 'B1',
      seller: {
        name: 'Vendeur SARL',
        siren: '111111111',
        address: { countryCode: 'FR' },
      },
      buyer: {
        name: 'Client SARL',
        siren: '222222222',
        address: { countryCode: 'FR' },
      },
      lines: [
        {
          id: '1',
          name: 'Bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '1000.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
      ],
    }
  }

  async function adminCookie(): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'super-admin-passphrase-1' })
      .expect(200)
    return res.headers['set-cookie'] as unknown as string[]
  }

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    billingRepo = new BillingRepository(
      new TenantContextService(appPool),
      appPool,
    )
    invoicesRepo = new InvoicesRepository(new TenantContextService(appPool))
    app = await createTestApp(db.appUrl)

    const hash = await hashPassword('super-admin-passphrase-1')
    await ownerPool.query(
      "INSERT INTO platform_admins (email, password_hash) VALUES ('root@factelec.fr', $1)",
      [hash],
    )

    // Tenant billing actif + 11 factures (> LAST_INVOICES_LIMIT=10, motif
    // vérifier le plafonnement du détail) — seedé DIRECTEMENT en base
    // (ownerPool + repos liés à factelec_app), motif billing-usage.e2e.test.ts
    // seedActiveTenant : plus rapide/déterministe qu'un signup + checkout
    // fake, et ce fichier n'a besoin d'aucun user réel sur ce tenant.
    const t = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Shop Billed') RETURNING id",
    )
    billedTenantId = t.rows[0].id
    await billingRepo.attachCustomer(billedTenantId, 'cus_admin_supervision')
    await billingRepo.applyEvent(billedTenantId, {
      customerId: 'cus_admin_supervision',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_admin_supervision',
      status: 'active',
      currentPeriodEnd: new Date('2026-08-19T00:00:00Z'),
    })
    for (let i = 0; i < 11; i++) {
      await invoicesRepo.insertReceived(
        billedTenantId,
        buildInvoice(invoiceInput(`F-${i}`)),
      )
    }

    // Tenant SANS ligne tenant_billing et SANS facture — couvre la branche
    // par défaut du miroir billing (`billingRow?.status ?? 'none'`,
    // `hasCustomer: false`) et la liste vide de factures, jamais exercées
    // par le tenant ci-dessus (toujours en état 'active').
    const t2 = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Shop Plain') RETURNING id",
    )
    plainTenantId = t2.rows[0].id
  })
  afterAll(async () => {
    await app.close()
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('requires a session for the tenants list (401)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenants')
      .expect(401)
    expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
  })

  it('requires a session for the tenant detail (401)', async () => {
    await request(app.getHttpServer())
      .get(`/admin/tenants/${billedTenantId}`)
      .expect(401)
  })

  it('forbids a regular (non-admin) tenant session (403) on both routes', async () => {
    const user = await signupSession(app, {
      email: 'viewer@shop.example',
      password: 'passphrase-viewer-1',
      organizationName: 'Shop Viewer',
      siren: null,
    })
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', user.cookie)
      .expect(403)
    await request(app.getHttpServer())
      .get(`/admin/tenants/${billedTenantId}`)
      .set('Cookie', user.cookie)
      .expect(403)
  })

  it('lists tenants enriched with billing/volume stats — the seeded active tenant shows billingStatus active and invoices30d >= 1', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookie)
      .expect(200)

    expect(Array.isArray(res.body.tenants)).toBe(true)
    const row = res.body.tenants.find(
      (t: { id: string }) => t.id === billedTenantId,
    )
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      name: 'Shop Billed',
      siren: null,
      suspendedAt: null,
      billingStatus: 'active',
    })
    expect(row.invoices30d).toBeGreaterThanOrEqual(11)
    expect(row.ereporting30d).toBe(0)
    expect(row.deadLetters).toBe(0)
    // Jamais l'id Stripe brut, même dans la liste (anti-fuite, spec §3).
    expect(row).not.toHaveProperty('stripeCustomerId')
  })

  it('tenant detail: stats row + last 10 invoices (capped) + billing mirror WITHOUT the raw Stripe customer id', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${billedTenantId}`)
      .set('Cookie', cookie)
      .expect(200)

    expect(res.body).toMatchObject({
      id: billedTenantId,
      name: 'Shop Billed',
      billingStatus: 'active',
    })

    expect(Array.isArray(res.body.invoices)).toBe(true)
    expect(res.body.invoices).toHaveLength(10) // plafonné, 11 factures seedées
    for (const inv of res.body.invoices) {
      expect(inv).toHaveProperty('id')
      expect(inv).toHaveProperty('number')
      expect(inv).toHaveProperty('lifecycleStatus')
      expect(inv).toHaveProperty('createdAt')
      // Projection stricte (spec §3) : jamais de montant/payload.
      expect(inv).not.toHaveProperty('amount')
      expect(inv).not.toHaveProperty('canonical')
    }

    expect(res.body.billing).toEqual({
      status: 'active',
      currentPeriodEnd: '2026-08-19T00:00:00.000Z',
      hasCustomer: true,
    })
    // Anti-fuite (spec §3) : ni au niveau racine, ni dans le miroir billing.
    expect(res.body).not.toHaveProperty('stripeCustomerId')
    expect(res.body.billing).not.toHaveProperty('stripeCustomerId')
    expect(JSON.stringify(res.body)).not.toContain('cus_admin_supervision')
  })

  it('tenant detail defaults to billing "none"/hasCustomer false and an empty invoices list for a tenant with no billing row and no invoices', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${plainTenantId}`)
      .set('Cookie', cookie)
      .expect(200)

    expect(res.body).toMatchObject({
      id: plainTenantId,
      name: 'Shop Plain',
      billingStatus: 'none',
      invoices30d: 0,
    })
    expect(res.body.invoices).toEqual([])
    expect(res.body.billing).toEqual({
      status: 'none',
      currentPeriodEnd: null,
      hasCustomer: false,
    })
  })

  it('404 problem for a malformed id (not a UUID)', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer())
      .get('/admin/tenants/not-a-uuid')
      .set('Cookie', cookie)
      .expect(404)
    expect(res.body.type).toBe('urn:factelec:problem:not-found')
  })

  it('404 problem for a well-formed but unknown UUID', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000')
      .set('Cookie', cookie)
      .expect(404)
    expect(res.body.type).toBe('urn:factelec:problem:not-found')
  })

  // Task 4 (spec §3/§4) : suspend/unsuspend + SuspensionGuard sur l'émission.
  // Suite SÉQUENTIELLE et DÉPENDANTE (motif billing-guard.e2e.test.ts) : un
  // seul tenant/clé API partagé, chaque `it` fait progresser son état
  // (suspendu ⇄ actif) — l'ordre de déclaration EST le scénario.
  describe('suspend/unsuspend tenant + garde sur l’émission (Task 4)', () => {
    let suspendTenantId: string
    let apiKeyToken: string
    let cookie: string[]
    let csrf: string

    function invoiceBody(number: string) {
      return invoiceInput(number)
    }

    // Cookie/CSRF admin obtenus UNE SEULE FOIS ici (pas un `adminCookie()`
    // par `it`, motif : `/admin/login` est throttlé 10/15min/IP — ce fichier
    // en consommerait plus de 10 à lui seul avec un login par test, faisant
    // échouer les derniers `it` en 429 avant même d'exercer le comportement
    // testé). La session (TTL admin 2h, spec §8) reste valide pour toute la
    // durée de cette suite.
    beforeAll(async () => {
      const t = await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('Shop Suspend') RETURNING id",
      )
      suspendTenantId = t.rows[0].id
      const key = await generateApiKey()
      await ownerPool.query(
        'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
        [suspendTenantId, key.prefix, key.secretHash, 'test-suspend'],
      )
      apiKeyToken = key.token
      cookie = await adminCookie()
      csrf = extractCookie(cookie, 'factelec_csrf')
    })

    it('POST /admin/tenants/:id/suspend SANS jeton CSRF → 403 forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/tenants/${suspendTenantId}/suspend`)
        .set('Cookie', cookie)
        .send({ reason: 'sans csrf' })
        .expect(403)
      expect(res.body.type).toBe('urn:factelec:problem:forbidden')
    })

    it('POST suspend (motif valide) → 200 { suspendedAt }', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/tenants/${suspendTenantId}/suspend`)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .send({ reason: 'impayé grave' })
        .expect(200)

      expect(res.body.suspendedAt).toBeDefined()
    })

    it('POST suspend un tenant DÉJÀ suspendu → 409 conflict (idempotence)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/tenants/${suspendTenantId}/suspend`)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .send({ reason: 'nouvelle tentative' })
        .expect(409)
      expect(res.body.type).toBe('urn:factelec:problem:conflict')
    })

    it('PENDANT la suspension : POST /invoices (clé API valide) → 403 tenant-suspended', async () => {
      const res = await request(app.getHttpServer())
        .post('/invoices')
        .set('Authorization', `Bearer ${apiKeyToken}`)
        .send(invoiceBody('FA-SUSPEND-1'))
        .expect(403)
      expect(res.body.type).toBe('urn:factelec:problem:tenant-suspended')
    })

    it('PENDANT la suspension : GET /invoices reste 200 (lecture jamais bloquée)', async () => {
      await request(app.getHttpServer())
        .get('/invoices')
        .set('Authorization', `Bearer ${apiKeyToken}`)
        .expect(200)
    })

    it('POST unsuspend → 204', async () => {
      await request(app.getHttpServer())
        .post(`/admin/tenants/${suspendTenantId}/unsuspend`)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .expect(204)
    })

    it('POST unsuspend un tenant NON suspendu → 409 conflict (idempotence)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/tenants/${suspendTenantId}/unsuspend`)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .expect(409)
      expect(res.body.type).toBe('urn:factelec:problem:conflict')
    })

    it('APRÈS la réactivation : POST /invoices → 201 (le garde laisse à nouveau passer)', async () => {
      const res = await request(app.getHttpServer())
        .post('/invoices')
        .set('Authorization', `Bearer ${apiKeyToken}`)
        .send(invoiceBody('FA-SUSPEND-2'))
        .expect(201)
      expect(res.body.status).toBeDefined()
    })

    it('journal admin_actions : 2 lignes (suspend_tenant puis unsuspend_tenant), tenant_id et detail corrects', async () => {
      const { rows } = await ownerPool.query(
        'SELECT action, tenant_id, detail FROM admin_actions WHERE tenant_id = $1 ORDER BY created_at ASC',
        [suspendTenantId],
      )
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        action: 'suspend_tenant',
        tenant_id: suspendTenantId,
        detail: { reason: 'impayé grave' },
      })
      expect(rows[1]).toMatchObject({
        action: 'unsuspend_tenant',
        tenant_id: suspendTenantId,
        detail: {},
      })
    })

    it('404 problem pour un tenant inconnu (suspend et unsuspend)', async () => {
      const unknown = '00000000-0000-0000-0000-000000000000'

      const suspendRes = await request(app.getHttpServer())
        .post(`/admin/tenants/${unknown}/suspend`)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .send({ reason: 'peu importe' })
        .expect(404)
      expect(suspendRes.body.type).toBe('urn:factelec:problem:not-found')

      const unsuspendRes = await request(app.getHttpServer())
        .post(`/admin/tenants/${unknown}/unsuspend`)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .expect(404)
      expect(unsuspendRes.body.type).toBe('urn:factelec:problem:not-found')
    })
  })

  // Task 6 (spec §3) : GET /admin/anomalies (SD 2 find_admin_anomalies) +
  // couture différée de la Task 3 (champ `anomalies` du détail per-tenant).
  // Suite LIGHT (Postgres seul, motif suspend/unsuspend ci-dessus) : ni
  // dead letter ni transmission CDV ne touchent BullMQ/Redis, seedées
  // DIRECTEMENT en base (ownerPool), motif billedTenantId plus haut.
  describe('anomalies (Task 6)', () => {
    let anomalyTenantId: string
    let cookie: string[]

    // Timestamps EXPLICITES et distincts (pas `now()` implicite) : le test
    // de tri (createdAt DESC) a besoin d'un ordre déterministe entre les 2
    // anomalies seedées, jamais garanti par un double INSERT au même
    // instant.
    const DEAD_LETTER_CREATED_AT = new Date('2026-07-18T10:00:00Z')
    const CDV_PARKED_CREATED_AT = new Date('2026-07-19T10:00:00Z')

    // Cookie admin obtenu UNE SEULE FOIS (motif describe suspend/unsuspend
    // ci-dessus, MÊME throttle 10/15min/IP sur /admin/login — ce fichier
    // dépasserait la limite avec un login par `it` sur les 6 tests ci-après,
    // en plus des logins déjà consommés par les describes précédents).
    beforeAll(async () => {
      cookie = await adminCookie()

      const t = await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('Shop Anomalies') RETURNING id",
      )
      anomalyTenantId = t.rows[0].id

      // Une seule facture porte les 2 anomalies (dead letter + transmission
      // CDV) : aucune contrainte d'unicité entre les 2 tables sources, motif
      // cdv-transmission-persistence.e2e.test.ts (INSERT SQL minimal, pas de
      // service dédié nécessaire pour un simple seed).
      const inv = await invoicesRepo.insertReceived(
        anomalyTenantId,
        buildInvoice(invoiceInput('ANOM-1')),
      )

      // `invoice_dead_letters` colonnes NOT NULL (schema.ts) : tenant_id,
      // invoice_id, reason, attempts — created_at posé explicitement
      // (au-dessus).
      await ownerPool.query(
        `INSERT INTO invoice_dead_letters
           (tenant_id, invoice_id, reason, attempts, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          anomalyTenantId,
          inv.id,
          'poison test seed',
          3,
          DEAD_LETTER_CREATED_AT,
        ],
      )

      // `cdv_transmissions` : status='parked' (une des 2 valeurs couvertes
      // par le kind 'cdv_parked' de la SD, avec 'rejected') — reject_reason
      // NULL ⇒ detail = status::text = 'parked' (coalesce, cf. migration
      // 0031).
      await ownerPool.query(
        `INSERT INTO cdv_transmissions
           (tenant_id, invoice_id, to_status, target, status, status_horodate, created_at)
         VALUES ($1, $2, 'deposee', 'ppf', 'parked', '20260719100000', $3)`,
        [anomalyTenantId, inv.id, CDV_PARKED_CREATED_AT],
      )
    })

    it('GET /admin/anomalies requires a session (401)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/anomalies')
        .expect(401)
      expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
    })

    it('lists the 2 seeded kinds (dead_letter, cdv_parked), sorted createdAt DESC', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/anomalies')
        .set('Cookie', cookie)
        .expect(200)

      expect(Array.isArray(res.body.anomalies)).toBe(true)
      const seeded = res.body.anomalies.filter(
        (a: { tenantId: string }) => a.tenantId === anomalyTenantId,
      )
      expect(seeded).toHaveLength(2)
      // Tri createdAt DESC (spec §3) : le plus récent (cdv_parked) d'abord.
      expect(seeded[0]).toMatchObject({
        kind: 'cdv_parked',
        tenantId: anomalyTenantId,
        detail: 'parked',
      })
      expect(seeded[1]).toMatchObject({
        kind: 'dead_letter',
        tenantId: anomalyTenantId,
        detail: 'poison test seed',
      })
      expect(new Date(seeded[0].createdAt).getTime()).toBeGreaterThan(
        new Date(seeded[1].createdAt).getTime(),
      )
    })

    it('limit=1 respects the bound (exactly 1 result, the most recent one)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/anomalies?limit=1')
        .set('Cookie', cookie)
        .expect(200)

      expect(res.body.anomalies).toHaveLength(1)
      expect(res.body.anomalies[0]).toMatchObject({ kind: 'cdv_parked' })
    })

    it.each([['0'], ['201'], ['abc']])(
      '422 validation pour un limit invalide (%s)',
      async (limit) => {
        const res = await request(app.getHttpServer())
          .get(`/admin/anomalies?limit=${limit}`)
          .set('Cookie', cookie)
          .expect(422)
        expect(res.body.type).toBe('urn:factelec:problem:validation-error')
      },
    )

    it('tenant detail: the field `anomalies` contains this tenant’s 2 seeded anomalies', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/tenants/${anomalyTenantId}`)
        .set('Cookie', cookie)
        .expect(200)

      expect(Array.isArray(res.body.anomalies)).toBe(true)
      expect(res.body.anomalies).toHaveLength(2)
      for (const a of res.body.anomalies) {
        expect(a.tenantId).toBe(anomalyTenantId)
      }
      expect(res.body.anomalies[0]).toMatchObject({ kind: 'cdv_parked' })
      expect(res.body.anomalies[1]).toMatchObject({ kind: 'dead_letter' })
    })

    it('tenant detail: an unrelated tenant has an empty `anomalies` array', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/tenants/${plainTenantId}`)
        .set('Cookie', cookie)
        .expect(200)

      expect(res.body.anomalies).toEqual([])
    })
  })
})
