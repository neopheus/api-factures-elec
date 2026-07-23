import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Preuve « fixtures ↔ API réelle » (Task 2, phase 4 it.1, spec §3) : ce test
// charge les 3 MÊMES fixtures que
// `packages/connectors-sdk/tests/order-mapping-schema.test.ts` (déjà
// validées contre le JSON Schema du contrat connecteur, `ajv`) et les POSTe
// contre une VRAIE instance de l'API. Un payload conforme au contrat
// documenté (JSON Schema, transcription indépendante) doit être accepté par
// le zod réel exécuté côté serveur (`invoiceInputSchema`,
// `@factelec/invoice-core`) — c'est cette adéquation-là, jamais garantie par
// construction entre deux schémas maintenus séparément, que ce fichier
// prouve. `b2c-sans-siren.json` (buyer sans SIREN, cas B2C) fait partie des
// 3 : sa réussite ici prouve que l'absence de SIREN est bien acceptée par
// l'API réelle, pas seulement supposée par le schéma du sdk.
//
// Résolution des fixtures VIA le package workspace (pas un chemin relatif
// traversant apps/api → packages/connectors-sdk à l'aveugle) :
// `import.meta.resolve` résout `@factelec/connectors-sdk/package.json` par
// la résolution de module Node réelle — exactement ce que ferait tout code
// qui dépend de ce paquet, dans ou hors de ce monorepo.
const CONNECTORS_SDK_DIR = dirname(
  fileURLToPath(import.meta.resolve('@factelec/connectors-sdk/package.json')),
)

// Retour typé `object` (pas `unknown`) : les fixtures sont un objet JSON
// racine par construction (validées comme tel côté sdk) — `object` suffit
// pour `supertest#send`, sans prétendre reproduire ici le type
// `OrderMappingPayload` (déjà vérifié par le sdk, pas le rôle de ce test).
function loadFixture(name: string): object {
  return JSON.parse(
    readFileSync(join(CONNECTORS_SDK_DIR, 'fixtures', name), 'utf8'),
  ) as object
}

const FIXTURES = [
  'b2b-siren.json',
  'b2c-sans-siren.json',
  'multi-taux-tva.json',
] as const

describe('POST /invoices — fixtures connectors-sdk (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })

  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it.each(FIXTURES)(
    'accepte la fixture %s du contrat connecteur → 201',
    async (name) => {
      const payload = loadFixture(name)
      const res = await request(app.getHttpServer())
        .post('/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send(payload)
        .expect(201)
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.body.status).toBe('received')
    },
  )
})
