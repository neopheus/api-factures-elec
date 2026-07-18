import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnnuaireRepository } from '../../src/annuaire/annuaire.repository.js'
import { generateActualisationXml } from '../../src/annuaire/flux13-xml.js'
import type { LigneAdressage } from '../../src/annuaire/ligne-adressage.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { ANNUAIRE_SYNC_JOB } from '../../src/queue/annuaire-sync.job.js'
import {
  ANNUAIRE_REPUBLISH_SWEEP_JOB,
  ANNUAIRE_SYNC_DIFF_JOB,
} from '../../src/queue/maintenance.job.js'
import {
  ANNUAIRE_SYNC_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import {
  createTestWorker,
  InMemoryAnnuaireStore,
  waitFor,
} from './helpers/worker.js'

// Ordonnanceur de synchronisation annuaire + worker d'ingestion Flux 14
// (Task 9, plan 2.4) — tâche d'INTÉGRATION, Postgres + Redis RÉELS
// (Testcontainers), port annuaire remplacé par InMemoryAnnuaireStore
// (helpers/worker.ts, motif InMemoryTransmissionSink 2.3) : aucun test
// n'écrit dans ./var/annuaire. Un worker PAR test (createTestWorker/close),
// motif ereporting-generation.e2e.test.ts. Couvre le pipeline complet
// (fetchConsultation -> validation XSD réelle (xmllint) -> parse -> upsert/
// remplacement du miroir) ET les injections revue (A-SYNC-RECONCILE,
// DateFinEffective, TypeFlux, STUCK-DRAFT RE-PUBLISH SWEEP).

let db: TestDb
let redis: TestRedis
let ownerPool: pg.Pool
let appPool: pg.Pool
let repo: AnnuaireRepository

beforeAll(async () => {
  ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
  ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
  appPool = new pg.Pool({ connectionString: db.appUrl })
  ownerPool.on('error', () => {})
  appPool.on('error', () => {})
  repo = new AnnuaireRepository(new TenantContextService(appPool))
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

interface F14Ligne {
  siren: string
  siret?: string
  nature: 'D' | 'M'
  dateDebut: string
  dateFin?: string
  dateFinEffective?: string
  plateforme: string
}

// Fixture F14 construite à la main — MÊME structure que les fixtures
// XSD-validées de tests/unit/flux14-parse.test.ts (InfoAdressage PLAT,
// identifiants flats). Validée par le VRAI xmllint au moment du parse
// (parseConsultationF14, appelé par AnnuaireSyncService à travers le
// pipeline complet) — jamais mockée ici.
function buildF14(typeFlux: 'C' | 'D', lignes: F14Ligne[]): string {
  const bloc =
    lignes.length === 0
      ? ''
      : `<BlocLignesAnnuaire>${lignes
          .map(
            (l, i) => `
    <LigneAnnuaire>
      <IdInstance>${i + 1}</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Nature>${l.nature}</Nature>
      <DateEffet>
        <DateDebut>${l.dateDebut}</DateDebut>${
          l.dateFin ? `\n        <DateFin>${l.dateFin}</DateFin>` : ''
        }${
          l.dateFinEffective
            ? `\n        <DateFinEffective>${l.dateFinEffective}</DateFinEffective>`
            : ''
        }
      </DateEffet>
      <InfoAdressage>
        <Identifiant>${l.siren}</Identifiant>
        <IdLinSIREN qualifiant="0002">${l.siren}</IdLinSIREN>${
          l.siret
            ? `\n        <IdLinSIRET qualifiant="0009">${l.siret}</IdLinSIRET>`
            : ''
        }
      </InfoAdressage>
      <IdPlateforme>${l.plateforme}</IdPlateforme>
    </LigneAnnuaire>`,
          )
          .join('')}
  </BlocLignesAnnuaire>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>${typeFlux}</TypeFlux>
  ${bloc}
</AnnuaireConsultationF14>`
}

async function mirrorRows(
  tenantId: string,
  siren: string,
): Promise<
  Array<{ nature: string; date_fin: string | null; plateforme: string }>
> {
  const r = await ownerPool.query(
    'SELECT nature, date_fin, plateforme FROM annuaire_directory_entries WHERE tenant_id = $1 AND siren = $2 ORDER BY plateforme',
    [tenantId, siren],
  )
  return r.rows
}

// ── Step 1 : scheduler + sweep ───────────────────────────────────────────

describe('AnnuaireScheduler + AnnuaireSweepService (Task 9 Step 1)', () => {
  it('enregistre les TROIS planificateurs répétables (diff/full/republish-sweep, bootstrap idempotent)', async () => {
    const worker = await createTestWorker(db.workerUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const schedulers = await maintenanceQueue.getJobSchedulers()
      const keys = schedulers.map((s) => s.key)
      expect(keys).toContain('annuaire-sync-diff')
      expect(keys).toContain('annuaire-sync-full')
      expect(keys).toContain('annuaire-republish-sweep')
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it('un sweep annuaire-sync-diff enfile un job annuaire-sync (TypeFlux=D) pour un tenant', async () => {
    const tenantId = await makeTenant('ANN-SYNC-SWEEP-D')
    const worker = await createTestWorker(db.workerUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const syncQueue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const sweepJob = await maintenanceQueue.add(ANNUAIRE_SYNC_DIFF_JOB, {})
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const jobs = await syncQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ])
      const mine = jobs.filter((j) => j.id?.startsWith(`${tenantId}:D:`))
      expect(mine).toHaveLength(1)
      expect(mine[0]!.data).toEqual({ tenantId, typeFlux: 'D' })
    } finally {
      await syncQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it("le sweep de reprise n'enfile QUE les drafts figés (>15 min), jamais un draft frais", async () => {
    const tenantId = await makeTenant('ANN-SYNC-STUCK-SWEEP')
    const { id: consentId } = await repo.insertConsent(tenantId, {
      siren: '700000001',
      consentType: 'mandat',
      signerIdentity: 'Sig',
      evidenceRef: 'EVID',
      obtainedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const { id: agedId } = await repo.insertLigne(tenantId, {
      siren: '700000001',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
      consentId,
    })
    const { id: freshId } = await repo.insertLigne(tenantId, {
      siren: '700000001',
      nature: 'D',
      dateDebut: '20260201',
      plateforme: '0002',
      consentId,
    })
    await ownerPool.query(
      "UPDATE annuaire_lignes SET created_at = now() - interval '20 minutes' WHERE id = $1",
      [agedId],
    )

    const worker = await createTestWorker(db.workerUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const syncQueue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const sweepJob = await maintenanceQueue.add(
        ANNUAIRE_REPUBLISH_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const jobs = await syncQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ])
      const ids = jobs.map((j) => j.id)
      expect(ids).toContain(`${agedId}-republish`)
      expect(ids).not.toContain(`${freshId}-republish`)
    } finally {
      await syncQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})

// ── Step 2 : ingestion F14 (job annuaire-sync) ───────────────────────────

describe('AnnuaireSyncProcessor — ingestion F14 (job annuaire-sync)', () => {
  it('ingère un F14 différentiel dans le miroir du tenant (parse -> upsert)', async () => {
    const tenantId = await makeTenant('ANN-SYNC-DIFF-1')
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000001',
          nature: 'D',
          dateDebut: '20260101',
          plateforme: '0001',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'D',
      })
      await waitFor(async () => (await job.getState()) === 'completed')

      const rows = await mirrorRows(tenantId, '800000001')
      expect(rows).toEqual([
        { nature: 'D', date_fin: null, plateforme: '0001' },
      ])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('est idempotent : deux syncs indépendants du MÊME F14 ne dupliquent pas (backstop DB, unique index)', async () => {
    const tenantId = await makeTenant('ANN-SYNC-IDEMP')
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000002',
          nature: 'D',
          dateDebut: '20260101',
          plateforme: '0001',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      // jobId EXPLICITEMENT distincts (bypass la dédup BullMQ, couche 2) :
      // preuve ISOLÉE de la couche 3 (backstop DB, index unique migration
      // 0018 réutilisé par le miroir A-MIRROR-KEY).
      const job1 = await queue.add(
        ANNUAIRE_SYNC_JOB,
        { tenantId, typeFlux: 'D' },
        { jobId: 'idemp-1' },
      )
      await waitFor(async () => (await job1.getState()) === 'completed')
      const job2 = await queue.add(
        ANNUAIRE_SYNC_JOB,
        { tenantId, typeFlux: 'D' },
        { jobId: 'idemp-2' },
      )
      await waitFor(async () => (await job2.getState()) === 'completed')

      const rows = await mirrorRows(tenantId, '800000002')
      expect(rows).toHaveLength(1)
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('ingère un Nature=M (masquage) dans le miroir — maille non résolue ensuite (resolveRecipient)', async () => {
    const { resolveRecipient, RecipientUnaddressableError } = await import(
      '../../src/annuaire/ligne-adressage.js'
    )
    const tenantId = await makeTenant('ANN-SYNC-MASK')
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000003',
          nature: 'M',
          dateDebut: '20260101',
          plateforme: '9998',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'D',
      })
      await waitFor(async () => (await job.getState()) === 'completed')

      const rows = await mirrorRows(tenantId, '800000003')
      expect(rows).toEqual([
        { nature: 'M', date_fin: null, plateforme: '9998' },
      ])

      const entries = await repo.findDirectoryEntries(tenantId, '800000003')
      const lignes: LigneAdressage[] = entries.map((e) => ({
        maille: {
          siren: e.siren,
          siret: e.siret ?? undefined,
          routageId: e.routageId ?? undefined,
          suffixe: e.suffixe ?? undefined,
        },
        nature: e.nature,
        dateDebut: e.dateDebut,
        dateFin: e.dateFin ?? undefined,
        plateforme: e.plateforme,
      }))
      expect(() =>
        resolveRecipient(lignes, { siren: '800000003' }, '20260615'),
      ).toThrow(RecipientUnaddressableError)
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('isole le miroir par tenant (RLS) : deux tenants synchronisés indépendamment', async () => {
    const tenantA = await makeTenant('ANN-SYNC-RLS-A')
    const tenantB = await makeTenant('ANN-SYNC-RLS-B')
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000004',
          nature: 'D',
          dateDebut: '20260101',
          plateforme: '0001',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const jobA = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId: tenantA,
        typeFlux: 'D',
      })
      const jobB = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId: tenantB,
        typeFlux: 'D',
      })
      await waitFor(async () => (await jobA.getState()) === 'completed')
      await waitFor(async () => (await jobB.getState()) === 'completed')

      expect(await mirrorRows(tenantA, '800000004')).toHaveLength(1)
      expect(await mirrorRows(tenantB, '800000004')).toHaveLength(1)

      const asB = await appPool.connect()
      try {
        await asB.query('BEGIN')
        await asB.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenantB,
        ])
        const r = await asB.query(
          'SELECT id FROM annuaire_directory_entries WHERE tenant_id = $1',
          [tenantA],
        )
        expect(r.rowCount).toBe(0)
        await asB.query('ROLLBACK')
      } finally {
        asB.release()
      }
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('un F14 vide (aucune fixture déposée) : no-op — aucune ligne, job complété sans erreur', async () => {
    const tenantId = await makeTenant('ANN-SYNC-EMPTY')
    const worker = await createTestWorker(db.workerUrl, redis) // port par défaut : aucune fixture
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'D',
      })
      await waitFor(async () => (await job.getState()) === 'completed')
      expect(await mirrorRows(tenantId, '800000005')).toEqual([])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('un F14 sémantiquement invalide (Nature hors {D,M}) : job complété SANS corrompre le miroir (log+skip)', async () => {
    const tenantId = await makeTenant('ANN-SYNC-BADNATURE')
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000006',
          // biome-ignore lint/suspicious/noExplicitAny: valeur délibérément hors nomenclature {D,M} pour exercer le rejet sémantique du parseur.
          nature: 'X' as any,
          dateDebut: '20260101',
          plateforme: '0001',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'D',
      })
      await waitFor(async () => (await job.getState()) === 'completed')
      expect(await mirrorRows(tenantId, '800000006')).toEqual([])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('DateFinEffective (injection revue T3) : le miroir stocke la fin EFFECTIVE min(dateFin, dateFinEffective)', async () => {
    const tenantId = await makeTenant('ANN-SYNC-DFE')
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000007',
          nature: 'D',
          dateDebut: '20260101',
          dateFin: '20270101',
          dateFinEffective: '20260601',
          plateforme: '0001',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'D',
      })
      await waitFor(async () => (await job.getState()) === 'completed')
      const rows = await mirrorRows(tenantId, '800000007')
      expect(rows).toEqual([
        { nature: 'D', date_fin: '20260601', plateforme: '0001' },
      ])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('A-SYNC-RECONCILE : un flux COMPLET (TypeFlux=C) supprime une entrée absente du flux (plateforme défunte)', async () => {
    const tenantId = await makeTenant('ANN-SYNC-REPLACE')
    // Miroir pré-existant : 2 mailles (siren identique, dateDebut distincts).
    await repo.upsertDirectoryEntries(tenantId, [
      {
        siren: '800000008',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0001', // conservée : présente dans le flux complet ci-dessous
      },
      {
        siren: '800000008',
        nature: 'D',
        dateDebut: '20260201',
        plateforme: '0002', // défunte : ABSENTE du flux complet ci-dessous
      },
    ])
    const port = new InMemoryAnnuaireStore()
    port.setConsultation(
      'C',
      buildF14('C', [
        {
          siren: '800000008',
          nature: 'D',
          dateDebut: '20260101',
          plateforme: '0001',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'C',
      })
      await waitFor(async () => (await job.getState()) === 'completed')
      const rows = await mirrorRows(tenantId, '800000008')
      expect(rows).toEqual([
        { nature: 'D', date_fin: null, plateforme: '0001' },
      ])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it("A-SYNC-RECONCILE : un flux DIFFÉRENTIEL (TypeFlux=D) NE supprime JAMAIS — l'entrée absente reste présente", async () => {
    const tenantId = await makeTenant('ANN-SYNC-NOREPLACE')
    await repo.upsertDirectoryEntries(tenantId, [
      {
        siren: '800000009',
        nature: 'D',
        dateDebut: '20260101',
        plateforme: '0003',
      },
    ])
    const port = new InMemoryAnnuaireStore()
    // Le différentiel ne porte qu'une AUTRE maille (autre dateDebut) — la
    // maille pré-existante n'apparaît PAS dans ce flux.
    port.setConsultation(
      'D',
      buildF14('D', [
        {
          siren: '800000009',
          nature: 'D',
          dateDebut: '20260301',
          plateforme: '0004',
        },
      ]),
    )
    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const queue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const job = await queue.add(ANNUAIRE_SYNC_JOB, {
        tenantId,
        typeFlux: 'D',
      })
      await waitFor(async () => (await job.getState()) === 'completed')
      const rows = await mirrorRows(tenantId, '800000009')
      expect(rows).toEqual([
        { nature: 'D', date_fin: null, plateforme: '0003' },
        { nature: 'D', date_fin: null, plateforme: '0004' },
      ])
    } finally {
      await queue.close()
      await worker.close()
    }
  })
})

// ── Step 2bis : STUCK-DRAFT RE-PUBLISH SWEEP (injection revue contrôleur) ─

describe('AnnuaireSyncProcessor — reprise de draft figé (job annuaire-republish)', () => {
  it('un draft AGÉ (>15 min) est republié (published, trackingRef = résultat write-once du port) ; un draft FRAIS ne l’est jamais', async () => {
    const tenantId = await makeTenant('ANN-REPUBLISH')
    const { id: consentId } = await repo.insertConsent(tenantId, {
      siren: '900000001',
      consentType: 'mandat',
      signerIdentity: 'Sig',
      evidenceRef: 'EVID',
      obtainedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const { id: agedId } = await repo.insertLigne(tenantId, {
      siren: '900000001',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
      consentId,
    })
    const { id: freshId } = await repo.insertLigne(tenantId, {
      siren: '900000001',
      nature: 'D',
      dateDebut: '20260201',
      plateforme: '0002',
      consentId,
    })

    // Simule le CRASH « entre port.publish et markPublished » (T8 F1) : le
    // F13 a DÉJÀ été émis auprès du port pour `agedId` — la ligne reste
    // pourtant 'draft' en base (aucun markPublished n'a suivi).
    const candidate: LigneAdressage = {
      maille: { siren: '900000001' },
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
    }
    const preXml = generateActualisationXml({
      codesRoutage: [],
      lignes: [candidate],
    })
    const port = new InMemoryAnnuaireStore()
    const preResult = await port.publish({
      tenantId,
      publicationRef: agedId,
      xml: preXml,
    })

    // Vieillit UNIQUEMENT `agedId` — `freshId` reste dans la fenêtre de
    // grâce des 15 min (SD find_stale_annuaire_drafts, migration 0020).
    await ownerPool.query(
      "UPDATE annuaire_lignes SET created_at = now() - interval '20 minutes' WHERE id = $1",
      [agedId],
    )

    const worker = await createTestWorker(db.workerUrl, redis, {
      annuairePort: port,
    })
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const syncQueue = new Queue(ANNUAIRE_SYNC_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const sweepJob = await maintenanceQueue.add(
        ANNUAIRE_REPUBLISH_SWEEP_JOB,
        {},
      )
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const republishJob = syncQueue.getJob(`${agedId}-republish`)
      await waitFor(
        async () => (await (await republishJob)?.getState()) === 'completed',
      )

      const rows = await ownerPool.query(
        'SELECT status, tracking_ref FROM annuaire_lignes WHERE id = $1',
        [agedId],
      )
      expect(rows.rows[0].status).toBe('published')
      // Idempotent PAR CONSTRUCTION : le port write-once renvoie le résultat
      // D'ORIGINE (celui du pré-appel simulant le crash), jamais un second
      // écrit — le trackingRef final EST celui du pré-appel.
      expect(rows.rows[0].tracking_ref).toBe(preResult.trackingRef)
      expect(rows.rows[0].tracking_ref).toMatch(/^[0-9a-f]{64}$/)

      const freshRow = await ownerPool.query(
        'SELECT status FROM annuaire_lignes WHERE id = $1',
        [freshId],
      )
      expect(freshRow.rows[0].status).toBe('draft')

      const events = await ownerPool.query(
        'SELECT to_status FROM annuaire_ligne_events WHERE ligne_id = $1 ORDER BY created_at',
        [agedId],
      )
      expect(events.rows.map((e) => e.to_status)).toEqual([
        'draft',
        'published',
      ])
    } finally {
      await syncQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})
