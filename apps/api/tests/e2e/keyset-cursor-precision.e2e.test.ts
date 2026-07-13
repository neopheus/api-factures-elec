import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Régression : created_at est un timestamptz Postgres à précision MICROseconde
// (defaultNow()), mais un Date JS n'a qu'une précision MILLIseconde. Si le
// curseur keyset transite par un Date JS, deux lignes qui partagent la même
// milliseconde mais diffèrent en microsecondes peuvent être ni `<` ni `=` par
// rapport à la frontière tronquée → une ligne est silencieusement sautée
// entre deux pages. Déclencheur réaliste : ingestions en lot dans la même ms.
describe('keyset cursor: precision microseconde aux frontières de page (régression)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  let tenantId: string
  let ids: string[]

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl)

    // 3 factures partageant EXACTEMENT la même milliseconde (12:00:00.123) mais
    // avec des microsecondes distinctes — insérées directement (owner,
    // contourne RLS) pour maîtriser created_at au microseconde près, ce que
    // l'ingestion normale (defaultNow()) ne permet pas.
    const canonical = {
      number: 'placeholder',
      issueDate: '2026-07-13',
      typeCode: '380',
      currency: 'EUR',
    }
    const rows: { id: string }[] = []
    for (const [number, microTimestamp] of [
      ['P-1', '2026-07-13 12:00:00.123400+00'],
      ['P-2', '2026-07-13 12:00:00.123450+00'],
      ['P-3', '2026-07-13 12:00:00.123499+00'],
    ] as const) {
      const res = await ownerPool.query(
        `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, status, canonical, created_at)
         VALUES ($1, $2, '380', '2026-07-13', 'EUR', 'generated', $3::jsonb, $4::timestamptz)
         RETURNING id`,
        [
          tenantId,
          number,
          JSON.stringify({ ...canonical, number }),
          microTimestamp,
        ],
      )
      rows.push(res.rows[0])
    }
    ids = rows.map((r) => r.id)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('paginating past a microsecond-collision boundary loses no row and duplicates none', async () => {
    const p1 = await request(app.getHttpServer())
      .get('/invoices?limit=2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(p1.body.items).toHaveLength(2)
    expect(p1.body.nextCursor).toBeTruthy()

    const p2 = await request(app.getHttpServer())
      .get(`/invoices?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const seenIds = [...p1.body.items, ...p2.body.items].map(
      (i: { id: string }) => i.id,
    )
    // Aucune perte : les 3 lignes insérées doivent toutes apparaître.
    expect(new Set(seenIds)).toEqual(new Set(ids))
    // Aucun doublon.
    expect(seenIds.length).toBe(new Set(seenIds).size)
    expect(seenIds).toHaveLength(3)
    expect(p2.body.nextCursor).toBeNull()
  })
})
