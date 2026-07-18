import type { InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { seedGeneratedInvoice } from './helpers/seed-invoice.js'

// Task 4 (plan 3.4, D8 — revert JUSTIFIÉ de D3/3.3) : filtre `GET
// /invoices?routingStatus=` + exposition de `routingStatus`/
// `recipientPlatform` dans le DTO de liste. LIGHT (Postgres seul, PAS de
// createTestWorker) — le routage est piloté directement en base (UPDATE via
// le pool owner, qui contourne RLS), pas via le pipeline worker.
const input: InvoiceInput = {
  number: 'placeholder',
  issueDate: '2026-07-13',
  dueDate: '2026-08-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'Service',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

async function seedInvoiceWithRouting(
  pool: pg.Pool,
  tenantId: string,
  number: string,
  status: string,
  platform: string | null = null,
): Promise<string> {
  const id = await seedGeneratedInvoice(pool, tenantId, { ...input, number })
  await pool.query(
    'UPDATE invoices SET routing_status = $1, recipient_platform = $2 WHERE id = $3',
    [status, platform, id],
  )
  return id
}

describe('GET /invoices?routingStatus= (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  // Tenant DÉDIÉ par test (plutôt qu'un tenant partagé via beforeAll) : les
  // assertions comparent l'ensemble EXACT des factures renvoyées au set
  // littéral attendu — un tenant partagé entre `it()` ferait fuir des
  // factures `unaddressable` d'un test dans le décompte d'un autre.
  async function newTenant(): Promise<{ tenantId: string; token: string }> {
    return seedTenantWithKey(ownerPool, `Tenant-${Math.random()}`)
  }

  it('GET /invoices?routingStatus=unaddressable ne renvoie que les factures unaddressable (sous RLS)', async () => {
    const { tenantId, token } = await newTenant()
    const unaddressableId = await seedInvoiceWithRouting(
      ownerPool,
      tenantId,
      'FA-FILTER-BASIC-1',
      'unaddressable',
    )
    await seedInvoiceWithRouting(
      ownerPool,
      tenantId,
      'FA-FILTER-BASIC-2',
      'pending',
    )
    await seedInvoiceWithRouting(
      ownerPool,
      tenantId,
      'FA-FILTER-BASIC-3',
      'resolved',
      'PPF',
    )
    await seedInvoiceWithRouting(
      ownerPool,
      tenantId,
      'FA-FILTER-BASIC-4',
      'ambiguous',
    )

    const res = await request(app.getHttpServer())
      .get('/invoices?routingStatus=unaddressable')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const ids = res.body.items.map((i: { id: string }) => i.id)
    expect(ids).toEqual([unaddressableId])
    for (const item of res.body.items) {
      expect(item.routingStatus).toBe('unaddressable')
    }
  })

  it('la liste expose désormais routingStatus et recipientPlatform', async () => {
    const { tenantId, token } = await newTenant()
    const id = await seedInvoiceWithRouting(
      ownerPool,
      tenantId,
      'FA-FILTER-EXPOSE-1',
      'resolved',
      'PPF-EXPOSE',
    )

    const res = await request(app.getHttpServer())
      .get('/invoices?routingStatus=resolved')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const item = res.body.items.find((i: { id: string }) => i.id === id)
    expect(item).toMatchObject({
      routingStatus: 'resolved',
      recipientPlatform: 'PPF-EXPOSE',
    })
  })

  it('pagination cohérente AVEC filtre : le curseur enchaîne sans saut ni doublon (keyset intact)', async () => {
    const { tenantId, token } = await newTenant()
    // Séquence interlignée : 5 `unaddressable` (celles attendues par le
    // filtre) entrecoupées de 4 factures d'AUTRES statuts (jamais attendues).
    // Oracle indépendant : le set attendu est le littéral des 5 ids seedés
    // `unaddressable`, comparé à l'UNION de toutes les pages parcourues.
    const expected: string[] = []
    const statuses: [string, string][] = [
      ['PAGE-1', 'unaddressable'],
      ['PAGE-2', 'pending'],
      ['PAGE-3', 'unaddressable'],
      ['PAGE-4', 'resolved'],
      ['PAGE-5', 'unaddressable'],
      ['PAGE-6', 'ambiguous'],
      ['PAGE-7', 'unaddressable'],
      ['PAGE-8', 'pending'],
      ['PAGE-9', 'unaddressable'],
    ]
    for (const [suffix, status] of statuses) {
      const id = await seedInvoiceWithRouting(
        ownerPool,
        tenantId,
        `FA-FILTER-PAGINATION-${suffix}`,
        status,
      )
      if (status === 'unaddressable') expected.push(id)
    }
    expect(expected).toHaveLength(5)

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const qs = cursor
        ? `/invoices?routingStatus=unaddressable&limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/invoices?routingStatus=unaddressable&limit=2'
      const res = await request(app.getHttpServer())
        .get(qs)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
      for (const item of res.body.items) {
        expect(item.routingStatus).toBe('unaddressable')
        seen.push(item.id)
      }
      cursor = res.body.nextCursor ?? undefined
      pages += 1
      expect(pages).toBeLessThan(10) // garde-fou anti-boucle infinie
    } while (cursor)

    expect(pages).toBeGreaterThanOrEqual(3) // 5 éléments / limit=2 → ≥3 pages
    expect(new Set(seen)).toEqual(new Set(expected))
    expect(seen.length).toBe(new Set(seen).size)
    expect(seen).toHaveLength(5)
  })

  it('routingStatus invalide → 422', async () => {
    const { token } = await newTenant()
    const res = await request(app.getHttpServer())
      .get('/invoices?routingStatus=not-a-real-status')
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
  })

  it('sans routingStatus → comportement inchangé (toutes les factures)', async () => {
    const { tenantId, token } = await newTenant()
    const seeded = [
      await seedInvoiceWithRouting(
        ownerPool,
        tenantId,
        'FA-NOFILTER-1',
        'pending',
      ),
      await seedInvoiceWithRouting(
        ownerPool,
        tenantId,
        'FA-NOFILTER-2',
        'resolved',
        'PPF',
      ),
      await seedInvoiceWithRouting(
        ownerPool,
        tenantId,
        'FA-NOFILTER-3',
        'unaddressable',
      ),
      await seedInvoiceWithRouting(
        ownerPool,
        tenantId,
        'FA-NOFILTER-4',
        'ambiguous',
      ),
    ]

    const withoutFilter = await request(app.getHttpServer())
      .get('/invoices?limit=100')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    // Aucun filtre implicite : les 4 factures, TOUS statuts confondus,
    // apparaissent — comportement byte-identique à l'absence du paramètre
    // avant ce changement.
    const ids = withoutFilter.body.items.map((i: { id: string }) => i.id)
    expect(new Set(ids)).toEqual(new Set(seeded))
  })
})
