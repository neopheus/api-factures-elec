import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BillingRepository } from '../../src/billing/billing.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Tests DIRECTS du repository (Postgres réel, Testcontainers, SANS worker
// BullMQ ni Redis) : reste dans le projet vitest `light` (motif
// heavy-suites.arch.test.ts — ce fichier ne démarre aucun Worker BullMQ, le
// helper de démarrage de worker n'y apparaît nulle part).
//
// Deux instances du repository, MÊME classe, deux rôles Postgres réels —
// exactement le patron de bootstrap disjoint app/worker (db.module.ts,
// worker-role-least-privilege.e2e.test.ts) : `repo` (pool factelec_app) pour
// getState/attachCustomer/applyEvent/findTenantByCustomer (SD 1, EXECUTE
// accordé à factelec_app SEUL) ; `workerRepo` (pool factelec_worker) pour
// recordUsage/markUsageReported (INSERT/UPDATE billing_usage_reports accordé
// au worker seul) et listSubscribedTenants (SD 2, EXECUTE accordé au worker
// seul). Les tests négatifs (cas 8/9) prouvent que cette séparation de rôle
// n'est pas un hasard de permissions larges.
describe('BillingRepository (e2e, Postgres réel)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let workerPool: pg.Pool
  let repo: BillingRepository
  let workerRepo: BillingRepository

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    workerPool = new pg.Pool({ connectionString: db.workerUrl })
    repo = new BillingRepository(new TenantContextService(appPool), appPool)
    workerRepo = new BillingRepository(
      new TenantContextService(workerPool),
      workerPool,
    )
  })

  afterAll(async () => {
    await workerPool.end()
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  // Un tenant frais par cas : `tenant_billing` a `tenant_id` en PRIMARY KEY
  // (une ligne par tenant), partager un tenant entre cas ferait fuiter l'état
  // CAS/customer d'un cas vers le suivant.
  async function newTenant(name: string): Promise<string> {
    const r = await ownerPool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    return r.rows[0].id
  }

  it('1. getState sans ligne renvoie l’état none', async () => {
    const tenantId = await newTenant('Billing 1')
    expect(await repo.getState(tenantId)).toEqual({
      status: 'none',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    })
  })

  it('2. attachCustomer crée la ligne (statut none), est idempotent, refuse un customer différent', async () => {
    const tenantId = await newTenant('Billing 2')

    await repo.attachCustomer(tenantId, 'cus_A')
    expect(await repo.getState(tenantId)).toEqual({
      status: 'none',
      stripeCustomerId: 'cus_A',
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    })

    // Ré-appel avec le MÊME customer : no-op idempotent (rejeu sûr).
    await expect(
      repo.attachCustomer(tenantId, 'cus_A'),
    ).resolves.toBeUndefined()
    expect((await repo.getState(tenantId)).stripeCustomerId).toBe('cus_A')

    // Customer DIFFÉRENT non-null : corruption de mapping → throw explicite.
    await expect(repo.attachCustomer(tenantId, 'cus_B')).rejects.toThrow()
    // L'échec ne doit rien avoir écrasé.
    expect((await repo.getState(tenantId)).stripeCustomerId).toBe('cus_A')
  })

  it('2bis. attachCustomer rattache un customer sur une ligne déjà existante mais encore sans customer (créée par applyEvent)', async () => {
    const tenantId = await newTenant('Billing 2bis')
    // applyEvent crée la ligne en premier (statut initial), SANS écrire le
    // customer — branche INSERT de applyEvent, jamais de stripeCustomerId.
    await repo.applyEvent(tenantId, {
      customerId: 'cus_2bis',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_2bis',
      status: 'active',
      currentPeriodEnd: null,
    })
    expect((await repo.getState(tenantId)).stripeCustomerId).toBeNull()

    // Ligne présente mais stripeCustomerId encore null : ce n'est PAS un
    // écrasement, juste un premier rattachement (branche UPDATE current === null).
    await repo.attachCustomer(tenantId, 'cus_2bis')
    expect(await repo.getState(tenantId)).toEqual({
      status: 'active',
      stripeCustomerId: 'cus_2bis',
      stripeSubscriptionId: 'sub_2bis',
      currentPeriodEnd: null,
    })
  })

  it('3. applyEvent est un CAS anti-réordonnancement : accepte, rejette un événement plus ancien, ré-accepte un plus récent', async () => {
    const tenantId = await newTenant('Billing 3')
    const t0 = new Date('2026-07-19T09:00:00Z')
    const t1 = new Date('2026-07-19T10:00:00Z')
    const t2 = new Date('2026-07-19T11:00:00Z')
    const periodEnd = new Date('2026-08-19T00:00:00Z')

    // Première application (ligne absente → INSERT), y compris le statut initial.
    const first = await repo.applyEvent(tenantId, {
      customerId: 'cus_3',
      occurredAt: t1,
      subscriptionId: 'sub_3',
      status: 'active',
      currentPeriodEnd: periodEnd,
    })
    expect(first).toBe(true)
    expect(await repo.getState(tenantId)).toEqual({
      status: 'active',
      stripeCustomerId: null, // applyEvent n'écrit jamais le customer (attachCustomer s'en charge)
      stripeSubscriptionId: 'sub_3',
      currentPeriodEnd: periodEnd,
    })

    // Événement plus ANCIEN (t0 < t1 déjà appliqué) avec un statut différent
    // : rejeté, aucune écriture, l'état reste celui de t1.
    const stale = await repo.applyEvent(tenantId, {
      customerId: 'cus_3',
      occurredAt: t0,
      subscriptionId: 'sub_3',
      status: 'canceled',
      currentPeriodEnd: null,
    })
    expect(stale).toBe(false)
    expect((await repo.getState(tenantId)).status).toBe('active')
    expect((await repo.getState(tenantId)).currentPeriodEnd).toEqual(periodEnd)

    // Événement plus RÉCENT (t2 > t1) : accepté, écrase l'état complet
    // (currentPeriodEnd redevient null car l'événement Stripe est l'état
    // complet, pas un patch partiel).
    const second = await repo.applyEvent(tenantId, {
      customerId: 'cus_3',
      occurredAt: t2,
      subscriptionId: 'sub_3',
      status: 'canceled',
      currentPeriodEnd: null,
    })
    expect(second).toBe(true)
    expect(await repo.getState(tenantId)).toEqual({
      status: 'canceled',
      stripeCustomerId: null,
      stripeSubscriptionId: 'sub_3',
      currentPeriodEnd: null,
    })
  })

  it('3bis. applyEvent avec evt.status null est une garde défensive : rejeté sans écriture', async () => {
    const tenantId = await newTenant('Billing 3bis')
    const result = await repo.applyEvent(tenantId, {
      customerId: 'cus_3bis',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_3bis',
      status: null,
      currentPeriodEnd: null,
    })
    expect(result).toBe(false)
    expect(await repo.getState(tenantId)).toEqual({
      status: 'none',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    })
  })

  it("4. RLS : un tenant B ne voit jamais la ligne d'un tenant A (getState → none), ni via SQL brut sous son contexte", async () => {
    const tenantA = await newTenant('Billing RLS A')
    const tenantB = await newTenant('Billing RLS B')
    await repo.attachCustomer(tenantA, 'cus_rls_a')
    await repo.applyEvent(tenantA, {
      customerId: 'cus_rls_a',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_rls_a',
      status: 'active',
      currentPeriodEnd: null,
    })

    // Vérifie d'abord (owner, BYPASSRLS) que la ligne de A existe bel et bien.
    const ownerCheck = await ownerPool.query(
      'SELECT status FROM tenant_billing WHERE tenant_id = $1',
      [tenantA],
    )
    expect(ownerCheck.rows).toHaveLength(1)

    // Via le repository, sous le contexte du tenant B : état none.
    expect(await repo.getState(tenantB)).toEqual({
      status: 'none',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    })

    // Preuve RLS directe (pas seulement applicative) : même en ciblant
    // EXPLICITEMENT tenant_id = A dans le WHERE, sous app.tenant_id = B la
    // policy `tenant_isolation` masque la ligne — 0 ligne renvoyée.
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      const r = await client.query(
        'SELECT status FROM tenant_billing WHERE tenant_id = $1',
        [tenantA],
      )
      expect(r.rowCount).toBe(0)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('5. findTenantByCustomer (SD 1, rôle factelec_app, sans contexte tenant) retrouve le tenant ; customer inconnu → null', async () => {
    const tenantId = await newTenant('Billing SD1')
    await repo.attachCustomer(tenantId, 'cus_sd1')

    // `repo` est construit sur le pool factelec_app et `findTenantByCustomer`
    // n'ouvre AUCUNE transaction/contexte tenant (pas de `tenant.run`) — le
    // SD (SECURITY DEFINER) bypasse lui-même la RLS.
    expect(await repo.findTenantByCustomer('cus_sd1')).toBe(tenantId)
    expect(await repo.findTenantByCustomer('cus_inconnu')).toBeNull()
  })

  it('6. recordUsage est idempotent (tenant, day) ; findUnreportedUsage/markUsageReported suivent le cycle', async () => {
    const tenantId = await newTenant('Billing Usage')

    // INSERT/UPDATE sur billing_usage_reports : accordé au SEUL
    // factelec_worker (migration 0030) → `workerRepo`.
    await workerRepo.recordUsage(tenantId, '2026-07-19', 5)
    await workerRepo.recordUsage(tenantId, '2026-07-19', 5) // rejeu : ON CONFLICT DO NOTHING

    const rows = await ownerPool.query(
      'SELECT count(*)::int AS n FROM billing_usage_reports WHERE tenant_id = $1',
      [tenantId],
    )
    expect(rows.rows[0].n).toBe(1)

    const unreported = await workerRepo.findUnreportedUsage(tenantId)
    expect(unreported).toHaveLength(1)
    expect(unreported[0]).toMatchObject({ day: '2026-07-19', count: 5 })

    await workerRepo.markUsageReported(tenantId, unreported[0]!.id)
    expect(await workerRepo.findUnreportedUsage(tenantId)).toEqual([])
  })

  it('7. listSubscribedTenants (SD 2, rôle factelec_worker) liste un tenant active, exclut none/canceled', async () => {
    const active = await newTenant('Billing Active')
    const none = await newTenant('Billing None')
    const canceled = await newTenant('Billing Canceled')

    await repo.attachCustomer(active, 'cus_active')
    await repo.applyEvent(active, {
      customerId: 'cus_active',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_active',
      status: 'active',
      currentPeriodEnd: null,
    })

    // `none` : jamais rattaché, aucune ligne en base — absent par construction.

    await repo.attachCustomer(canceled, 'cus_canceled')
    await repo.applyEvent(canceled, {
      customerId: 'cus_canceled',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_canceled',
      status: 'canceled',
      currentPeriodEnd: null,
    })

    const subscribed = await workerRepo.listSubscribedTenants()
    expect(subscribed).toContainEqual({
      tenantId: active,
      stripeCustomerId: 'cus_active',
    })
    expect(subscribed.map((s) => s.tenantId)).not.toContain(none)
    expect(subscribed.map((s) => s.tenantId)).not.toContain(canceled)
  })

  it('8. SD 1 exige le rôle factelec_app : EXECUTE refusé (42501) sous factelec_worker', async () => {
    await expect(
      workerRepo.findTenantByCustomer('peu-importe'),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('9. SD 2 exige le rôle factelec_worker : EXECUTE refusé (42501) sous factelec_app', async () => {
    await expect(repo.listSubscribedTenants()).rejects.toMatchObject({
      code: '42501',
    })
  })
})
