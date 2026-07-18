import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import { Queue } from 'bullmq'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import {
  EREPORTING_GENERATE_JOB,
  type EreportingGenerationJob,
} from '../../src/queue/ereporting-generation.job.js'
import { EREPORTING_GENERATION_QUEUE } from '../../src/queue/queue.constants.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Worker de génération e-reporting — branche RETRANSMISSION (plan 3.4, Task
// 1, D3/D5) : un job `type='RE'` traverse le MÊME pipeline que l'IN
// (ereporting-generation.e2e.test.ts) — seul le discriminant `reSeq`
// distingue le ref (buildTransmissionRef) et l'arbitrage de conflit
// (insertTransmission, index partiel RE, migration 0027). Task 1 livre le
// PIPELINE seul : les jobs RE sont enfilés DIRECTEMENT ici (pas d'endpoint
// HTTP — Task 2), motif identique à ereporting-generation.e2e.test.ts.
// Postgres + Redis RÉELS (Testcontainers), sink de transmission en mémoire
// (helpers/worker.ts). Un worker PAR test (createTestWorker/close).
//
// Dernier `it()` (Task 2, D1/D2) : bout-en-bout endpoint→worker — étend ce
// fichier HEAVY plutôt que d'en créer un second (choix le plus simple,
// justifié au brief : Postgres+Redis+worker y sont déjà disponibles). Le
// fichier LIGHT `ereporting-retransmission-endpoint.e2e.test.ts` couvre
// séparément l'enfilement/les garde-fous SANS worker (verrou heavy-suites).

const b2cInvoice = (
  number: string,
  sellerSiren: string,
  issueDate: string,
): InvoiceInput => ({
  number,
  issueDate,
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'B1',
  seller: {
    name: 'Vendeur',
    siren: sellerSiren,
    address: { countryCode: 'FR' },
  },
  buyer: { name: 'Client particulier', address: { countryCode: 'FR' } },
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
})

describe('ereporting retransmission worker RE (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let invoicesRepo: InvoicesRepository

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    invoicesRepo = new InvoicesRepository(new TenantContextService(appPool))
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  async function makeTenant(name: string): Promise<string> {
    const t = await ownerPool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    return t.rows[0].id
  }

  async function makeDeclarant(
    tenantId: string,
    siren: string,
    role: 'SE' | 'BY' = 'SE',
  ): Promise<string> {
    const d = await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
       VALUES ($1, $2, 'Déclarant e2e', $3, 'reel_normal_mensuel') RETURNING id`,
      [tenantId, siren, role],
    )
    return d.rows[0].id
  }

  function jobPayload(
    over: Partial<EreportingGenerationJob> &
      Pick<EreportingGenerationJob, 'tenantId' | 'declarantId' | 'siren'>,
  ): EreportingGenerationJob {
    return {
      role: 'SE',
      fluxKind: 'transactions',
      periodStart: '20260901',
      periodEnd: '20260910',
      type: 'IN',
      ...over,
    }
  }

  async function transmittedCount(
    declarantId: string,
    type: 'IN' | 'RE',
  ): Promise<number> {
    const r = await ownerPool.query(
      `SELECT count(*)::int AS n FROM ereporting_transmissions
         WHERE declarant_id = $1 AND type = $2 AND status = 'transmitted'`,
      [declarantId, type],
    )
    return r.rows[0].n
  }

  it('un job type=RE régénère la période COMPLÈTE depuis les données source ACTUELLES (transmission RE créée, ref …-RE-0)', async () => {
    const tenantId = await makeTenant('ERE-RE-1')
    const siren = '611111111'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-RE-1-1', siren, '2026-09-05')),
    )

    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'IN')) === 1,
      )

      // Correction/complément des données source AVANT le RE — la
      // régénération doit refléter l'état ACTUEL, pas celui capturé par l'IN.
      await invoicesRepo.insertReceived(
        tenantId,
        buildInvoice(b2cInvoice('FA-RE-1-2', siren, '2026-09-06')),
      )

      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren, type: 'RE', reSeq: 0 }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'RE')) === 1,
      )

      const re = await ownerPool.query(
        `SELECT transmission_ref, invoice_count, status, xml FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'RE'`,
        [declarantId],
      )
      expect(re.rows).toHaveLength(1)
      expect(re.rows[0].transmission_ref).toMatch(/-RE-0$/)
      expect(re.rows[0].transmission_ref.length).toBeLessThanOrEqual(50)
      expect(re.rows[0].status).toBe('transmitted')
      // Régénération COMPLÈTE depuis les données ACTUELLES : les DEUX
      // factures (celle de l'IN + celle ajoutée après) sont dans le RE.
      expect(re.rows[0].invoice_count).toBe(2)
      // Oracle indépendant sur les MONTANTS du XML RE (revue T1, NIT-1) :
      // 2 factures B2C à 1000.00 HT / 20 %, à des DATES DIFFÉRENTES (05/09 et
      // 06/09) → l'agrégat 10.3 groupe par (date, devise, catégorie) : DEUX
      // buckets de 1000.00 HT / 200.00 TVA chacun (calculé à la main) — la
      // sémantique « annule et remplace » porte sur les montants, pas
      // seulement le compte de factures.
      const teaCount = (
        re.rows[0].xml.match(
          /<TaxExclusiveAmount>1000\.00<\/TaxExclusiveAmount>/g,
        ) ?? []
      ).length
      expect(teaCount).toBe(2)
      const dates = ['20260905', '20260906'].filter((d) =>
        re.rows[0].xml.includes(`<Date>${d}</Date>`),
      )
      expect(dates).toEqual(['20260905', '20260906'])

      const inRow = await ownerPool.query(
        `SELECT invoice_count FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'IN'`,
        [declarantId],
      )
      // L'IN reste tel qu'au moment de SA génération (1 seule facture alors).
      expect(inRow.rows[0].invoice_count).toBe(1)
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('modifier une facture puis re-RE (reSeq=1) → nouvelle transmission …-RE-1 distincte, l’IN et le RE-0 subsistent (journal append-only)', async () => {
    const tenantId = await makeTenant('ERE-RE-2')
    const siren = '622222222'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-RE-2-1', siren, '2026-09-05')),
    )

    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'IN')) === 1,
      )

      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren, type: 'RE', reSeq: 0 }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'RE')) === 1,
      )

      // Nouvelle correction des données source, puis SECOND rectificatif
      // (reSeq=1, discriminant DISTINCT — jamais fabriqué par l'horloge).
      await invoicesRepo.insertReceived(
        tenantId,
        buildInvoice(b2cInvoice('FA-RE-2-2', siren, '2026-09-06')),
      )
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren, type: 'RE', reSeq: 1 }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'RE')) === 2,
      )

      const allRe = await ownerPool.query(
        `SELECT transmission_ref, invoice_count FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'RE' ORDER BY created_at`,
        [declarantId],
      )
      expect(allRe.rows).toHaveLength(2)
      expect(allRe.rows[0].transmission_ref).toMatch(/-RE-0$/)
      expect(allRe.rows[0].invoice_count).toBe(1)
      expect(allRe.rows[1].transmission_ref).toMatch(/-RE-1$/)
      expect(allRe.rows[1].invoice_count).toBe(2)
      expect(allRe.rows[0].transmission_ref).not.toBe(
        allRe.rows[1].transmission_ref,
      )

      // Journal append-only : IN + RE-0 + RE-1 subsistent TOUS, aucun écrasé.
      const allTypes = await ownerPool.query(
        `SELECT type FROM ereporting_transmissions
           WHERE declarant_id = $1 ORDER BY created_at`,
        [declarantId],
      )
      expect(allTypes.rows.map((r: { type: string }) => r.type)).toEqual([
        'IN',
        'RE',
        'RE',
      ])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('retry-idempotence : rejouer le MÊME job RE (reSeq fixe) → created:false, reprise, AUCUNE ligne dupliquée', async () => {
    const tenantId = await makeTenant('ERE-RE-3')
    const siren = '633333333'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-RE-3-1', siren, '2026-09-05')),
    )

    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'IN')) === 1,
      )

      const rePayload = jobPayload({
        tenantId,
        declarantId,
        siren,
        type: 'RE',
        reSeq: 0,
      })
      await queue.add(EREPORTING_GENERATE_JOB, rePayload)
      await waitFor(
        async () => (await transmittedCount(declarantId, 'RE')) === 1,
      )

      const before = await ownerPool.query(
        `SELECT id, tracking_id FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'RE'`,
        [declarantId],
      )
      expect(before.rows).toHaveLength(1)

      // Rejeu explicite : MÊME payload (même reSeq → même ref), un job BullMQ
      // distinct (jobId différent — la dédup BullMQ elle-même est hors
      // périmètre ici, motif ereporting-generation.e2e.test.ts « idempotence
      // #4 »). L'idempotence testée est celle du SERVICE au niveau base
      // (insertTransmission created:false → reprise verbatim).
      const replay = await queue.add(EREPORTING_GENERATE_JOB, rePayload)
      await waitFor(async () => (await replay.getState()) === 'completed')

      const after = await ownerPool.query(
        `SELECT id, tracking_id FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'RE'`,
        [declarantId],
      )
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].id).toBe(before.rows[0].id)
      expect(after.rows[0].tracking_id).toBe(before.rows[0].tracking_id)

      const events = await ownerPool.query(
        'SELECT to_status FROM ereporting_status_events WHERE transmission_id = $1',
        [before.rows[0].id],
      )
      expect(
        events.rows.map((e: { to_status: string }) => e.to_status),
      ).toEqual(['prepared', 'transmitted'])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it("l'IN du slot n'est jamais effacé ni muté par un RE", async () => {
    const tenantId = await makeTenant('ERE-RE-4')
    const siren = '644444444'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-RE-4-1', siren, '2026-09-05')),
    )

    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'IN')) === 1,
      )

      const inBefore = await ownerPool.query(
        `SELECT * FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'IN'`,
        [declarantId],
      )
      expect(inBefore.rows).toHaveLength(1)

      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren, type: 'RE', reSeq: 0 }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'RE')) === 1,
      )

      const inAfter = await ownerPool.query(
        `SELECT * FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'IN'`,
        [declarantId],
      )
      expect(inAfter.rows).toHaveLength(1)
      // Ligne byte-identique — le RE n'a NI muté NI effacé l'IN.
      expect(inAfter.rows[0]).toEqual(inBefore.rows[0])

      const inEvents = await ownerPool.query(
        `SELECT to_status FROM ereporting_status_events
           WHERE transmission_id = $1 ORDER BY created_at`,
        [inBefore.rows[0].id],
      )
      expect(
        inEvents.rows.map((e: { to_status: string }) => e.to_status),
      ).toEqual(['prepared', 'transmitted'])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('bout-en-bout : POST /ereporting/retransmissions (202) → le worker produit la transmission RE (plan 3.4, Task 2, D1/D2)', async () => {
    const { tenantId, token } = await seedTenantWithKey(ownerPool, 'ERE-RE-5')
    const siren = '655555555'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-RE-5-1', siren, '2026-09-05')),
    )

    const worker = await createTestWorker(db.appUrl, redis)
    const app: INestApplication = await createTestApp(db.appUrl, {
      host: redis.host,
      port: redis.port,
    })
    const seedQueue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      // IN préalable requis par le garde D4 — via le worker, motif des
      // autres `it()` de ce fichier (jamais via l'endpoint, réservé au RE).
      await seedQueue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(
        async () => (await transmittedCount(declarantId, 'IN')) === 1,
      )

      // Déclenchement OPÉRATEUR réel via l'endpoint dual-auth (D1 : AUCUN
      // automatisme post-301 — le test appelle explicitement le POST, comme
      // le ferait un opérateur après correction des données source).
      const res = await request(app.getHttpServer())
        .post('/ereporting/retransmissions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          declarantId,
          fluxKind: 'transactions',
          periodStart: '20260901',
        })
        .expect(202)
      expect(res.body).toEqual({
        jobId: `${declarantId}-transactions-20260901-RE-0`,
        transmissionRef: `ER-${declarantId.slice(0, 8)}-20260901-RE-0`,
      })

      await waitFor(
        async () => (await transmittedCount(declarantId, 'RE')) === 1,
      )

      const re = await ownerPool.query(
        `SELECT transmission_ref, status FROM ereporting_transmissions
           WHERE declarant_id = $1 AND type = 'RE'`,
        [declarantId],
      )
      expect(re.rows).toHaveLength(1)
      // La transmission créée par le WORKER porte EXACTEMENT le ref annoncé
      // par la réponse HTTP (le `reSeq` retourné à l'opérateur et celui du
      // payload du job sont IDENTIQUES, cf. rapport Task 1).
      expect(re.rows[0].transmission_ref).toBe(res.body.transmissionRef)
      expect(re.rows[0].status).toBe('transmitted')
    } finally {
      await seedQueue.close()
      await app.close()
      await worker.close()
    }
  })
})
