import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplicationContext } from '@nestjs/common'
import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import {
  CDV_STUCK_RETRY_JOB,
  CDV_TRANSMISSION_SWEEP_JOB,
} from '../../src/queue/maintenance.job.js'
import {
  CDV_TRANSMISSION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Ordonnanceur CDV borné 24h + worker + reprise des transmissions `parked`
// (Task 7, plan 3.1) : vérifie, contre un VRAI Redis (BullMQ) et un VRAI
// Postgres (find_cdv_transmissions_due / find_parked_cdv_transmissions, SD
// cross-tenant — migrations 0022/0023), le sweep bout-en-bout (2 cibles,
// jobId déterministe, fenêtre bornée D8) ET la reprise `parked`→`transmitted`
// (annuaire devenu adressable) — PROUVANT au passage l'injection revue T6
// F1/F2 (xml + recipientMatricule PERSISTÉS sur une reprise réussie, pas
// seulement status/trackingRef).

describe('ordonnanceur CDV borné (24h) + worker + reprise des parked (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  async function seedTenant(name: string): Promise<string> {
    const t = await ownerPool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    return t.rows[0].id
  }

  function invoiceInput(
    number: string,
    buyerSiren: string,
    overrides: Partial<InvoiceInput> = {},
  ): InvoiceInput {
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
        siren: buyerSiren,
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
      ...overrides,
    }
  }

  async function seedInvoice(
    worker: INestApplicationContext,
    tenantId: string,
    number: string,
    buyerSiren: string,
  ): Promise<string> {
    const invoicesRepo = worker.get(InvoicesRepository)
    const { id } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput(number, buyerSiren)),
    )
    return id
  }

  async function insertInvoiceDirect(
    tenantId: string,
    number: string,
  ): Promise<string> {
    const r = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, $2, '380', '2026-07-16', 'EUR', '{}'::jsonb) RETURNING id`,
      [tenantId, number],
    )
    return r.rows[0].id
  }

  async function insertStatusEvent(
    tenantId: string,
    invoiceId: string,
    toStatus: string,
    createdAt: Date,
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO invoice_status_events (tenant_id, invoice_id, from_status, to_status, actor, created_at)
       VALUES ($1, $2, NULL, $3, 'platform', $4)`,
      [tenantId, invoiceId, toStatus, createdAt],
    )
  }

  async function cdvRow(
    invoiceId: string,
    target: 'ppf' | 'recipient',
  ): Promise<{
    status: string
    tracking_ref: string | null
    xml: string | null
    recipient_matricule: string | null
  } | null> {
    const r = await ownerPool.query(
      `SELECT status, tracking_ref, xml, recipient_matricule
         FROM cdv_transmissions WHERE invoice_id = $1 AND target = $2`,
      [invoiceId, target],
    )
    return r.rows[0] ?? null
  }

  it('the scheduler registers the repeatable cdv-transmission-sweep and cdv-stuck-retry job schedulers (idempotent bootstrap)', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const schedulers = await maintenanceQueue.getJobSchedulers()
      expect(
        schedulers.some(
          (s) =>
            s.key === 'cdv-transmission-sweep' ||
            s.name === CDV_TRANSMISSION_SWEEP_JOB,
        ),
      ).toBe(true)
      expect(
        schedulers.some(
          (s) => s.key === 'cdv-stuck-retry' || s.name === CDV_STUCK_RETRY_JOB,
        ),
      ).toBe(true)
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it('transmet les statuts obligatoires dus vers PPF (1 event obligatoire → 1 transmission PPF), enfile aussi la cible recipient', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const cdvQueue = new Queue(CDV_TRANSMISSION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const tenantId = await seedTenant('CDV-SWEEP-PPF')
      const invoiceId = await seedInvoice(
        worker,
        tenantId,
        'CDV-SWEEP-PPF-1',
        '900000101', // pas d'entrée annuaire -> recipient parkera
      )

      const sweepJob = await maintenanceQueue.add(
        CDV_TRANSMISSION_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const jobs = await cdvQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ])
      const ids = jobs.map((j) => j.id).sort()
      expect(ids).toEqual(
        [`${invoiceId}-deposee-ppf`, `${invoiceId}-deposee-recipient`].sort(),
      )

      await waitFor(async () => {
        const row = await cdvRow(invoiceId, 'ppf')
        return row?.status === 'transmitted'
      })
      const ppfRow = await cdvRow(invoiceId, 'ppf')
      expect(ppfRow).toMatchObject({ status: 'transmitted' })
      expect(ppfRow?.tracking_ref).not.toBeNull()
      expect(ppfRow?.xml).not.toBeNull()
      expect(ppfRow?.recipient_matricule).toBeNull() // PPF : jamais résolu (D7)
    } finally {
      await cdvQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it("n'enfile PAS les statuts facultatifs (204/205… hors périmètre, D7)", async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const cdvQueue = new Queue(CDV_TRANSMISSION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const tenantId = await seedTenant('CDV-SWEEP-FACULTATIF')
      const invoiceId = await insertInvoiceDirect(
        tenantId,
        'CDV-SWEEP-FACULTATIF-1',
      )
      // Facultatif (approuvee, code 205) — hors périmètre D7, jamais transmis.
      await insertStatusEvent(tenantId, invoiceId, 'approuvee', new Date())

      const sweepJob = await maintenanceQueue.add(
        CDV_TRANSMISSION_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const jobs = await cdvQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ])
      expect(jobs.some((j) => j.id?.startsWith(invoiceId))).toBe(false)
      expect(await cdvRow(invoiceId, 'ppf')).toBeNull()
      expect(await cdvRow(invoiceId, 'recipient')).toBeNull()
    } finally {
      await cdvQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it('est idempotent : un second sweep ne duplique pas les jobs/lignes (created:false + jobId + unique DB, 3 couches D8)', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const cdvQueue = new Queue(CDV_TRANSMISSION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const tenantId = await seedTenant('CDV-SWEEP-IDEM')
      const invoiceId = await seedInvoice(
        worker,
        tenantId,
        'CDV-SWEEP-IDEM-1',
        '900000102',
      )

      const firstSweep = await maintenanceQueue.add(
        CDV_TRANSMISSION_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await firstSweep.getState()) === 'completed')
      await waitFor(async () => {
        const row = await cdvRow(invoiceId, 'ppf')
        return row?.status === 'transmitted'
      })
      // Filtré par CETTE facture : la file `cdv-transmission` est PARTAGÉE
      // par tout le fichier de test (même Redis) — d'autres `it()` y ont
      // déjà enfilé des jobs pour d'AUTRES factures, sans rapport avec ce
      // test d'idempotence.
      const jobsForThisInvoice = async (): Promise<string[]> =>
        (await cdvQueue.getJobs(['waiting', 'active', 'delayed', 'completed']))
          .map((j) => j.id)
          .filter(
            (id): id is string => id?.startsWith(`${invoiceId}-`) ?? false,
          )
          .sort()

      const beforeIds = await jobsForThisInvoice()

      const secondSweep = await maintenanceQueue.add(
        CDV_TRANSMISSION_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await secondSweep.getState()) === 'completed')
      const afterIds = await jobsForThisInvoice()

      // Même jeu de jobId AVANT/APRÈS (couche 2) — aucun doublon.
      expect(afterIds).toEqual(beforeIds)
      expect(afterIds).toHaveLength(2)

      // Backstop DB (couche 3) — toujours UNE seule ligne par (facture,
      // statut, cible), quel que soit le nombre de sweeps.
      const countRow = await ownerPool.query(
        `SELECT count(*)::int AS n FROM cdv_transmissions WHERE invoice_id = $1`,
        [invoiceId],
      )
      expect(countRow.rows[0].n).toBe(2) // ppf + recipient, 1 chacun
    } finally {
      await cdvQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it("respecte la fenêtre bornée (un event hors CDV_TRANSMISSION_LOOKBACK_MS n'est pas ré-enfilé, D8)", async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const cdvQueue = new Queue(CDV_TRANSMISSION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const tenantId = await seedTenant('CDV-SWEEP-STALE')
      const invoiceId = await insertInvoiceDirect(tenantId, 'CDV-SWEEP-STALE-1')
      // Obligatoire (deposee) mais HORS fenêtre (défaut 48h) — 3 jours.
      const stale = new Date(Date.now() - 3 * 24 * 3_600_000)
      await insertStatusEvent(tenantId, invoiceId, 'deposee', stale)

      const sweepJob = await maintenanceQueue.add(
        CDV_TRANSMISSION_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const jobs = await cdvQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ])
      expect(jobs.some((j) => j.id?.startsWith(invoiceId))).toBe(false)
      expect(await cdvRow(invoiceId, 'ppf')).toBeNull()
      expect(await cdvRow(invoiceId, 'recipient')).toBeNull()
    } finally {
      await cdvQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it('reprend une transmission parked quand l’annuaire devient adressable (parked→transmitted) — PROUVE xml+recipient_matricule persistés (injection revue T6 F1/F2)', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const tenantId = await seedTenant('CDV-STUCK-RETRY')
      const buyerSiren = '900000103'
      const invoiceId = await seedInvoice(
        worker,
        tenantId,
        'CDV-STUCK-RETRY-1',
        buyerSiren, // aucune entrée annuaire -> non adressable
      )

      const sweepJob = await maintenanceQueue.add(
        CDV_TRANSMISSION_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await sweepJob.getState()) === 'completed')
      await waitFor(async () => {
        const row = await cdvRow(invoiceId, 'recipient')
        return row?.status === 'parked'
      })
      const parkedRow = await cdvRow(invoiceId, 'recipient')
      expect(parkedRow?.xml).toBeNull() // résolution échouée AVANT toute génération F6
      expect(parkedRow?.recipient_matricule).toBeNull()

      // L'annuaire devient adressable — la reprise doit résoudre en place.
      const annuaireRepo = worker.get(AnnuaireRepository)
      await annuaireRepo.upsertDirectoryEntries(tenantId, [
        {
          siren: buyerSiren,
          nature: 'D',
          dateDebut: '20260101',
          plateforme: '0099',
        },
      ])

      const retryJob = await maintenanceQueue.add(CDV_STUCK_RETRY_JOB, {})
      await waitFor(async () => (await retryJob.getState()) === 'completed')
      await waitFor(async () => {
        const row = await cdvRow(invoiceId, 'recipient')
        return row?.status === 'transmitted'
      })

      const resumedRow = await cdvRow(invoiceId, 'recipient')
      expect(resumedRow).toMatchObject({
        status: 'transmitted',
        recipient_matricule: '0099',
      })
      expect(resumedRow?.tracking_ref).not.toBeNull()
      // Injection revue T6 (F1/F2, BINDING) : le XML réellement transmis au
      // port EST persisté sur la reprise — pas seulement status/trackingRef.
      expect(resumedRow?.xml).not.toBeNull()
      expect(resumedRow?.xml).toContain('CDV-STUCK-RETRY-1')
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})
