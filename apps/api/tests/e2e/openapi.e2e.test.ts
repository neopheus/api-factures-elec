import { readFileSync } from 'node:fs'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'

// Version ATTENDUE lue du VRAI package.json (pas de mock) — le document doit
// refléter la version publiée du paquet, jamais une valeur figée dans le
// test (motif health.controller.test.ts#EXPECTED_MIGRATIONS).
const PACKAGE_URL = new URL('../../package.json', import.meta.url)
const EXPECTED_VERSION = (
  JSON.parse(readFileSync(PACKAGE_URL, 'utf8')) as { version: string }
).version

// Préfixes ABSOLUS bannis du document public (mandat brief Task 1, phase 4
// it.1) : /admin (opérateur plateforme), /auth (session dashboard), /billing
// (Stripe), /metrics (Prometheus interne) — aucun ne doit fuiter, quel que
// soit le guard réel posé dessus.
const FORBIDDEN_PATH_PREFIXES = ['/admin', '/auth', '/billing', '/metrics']

describe('GET /openapi.json (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  // biome-ignore lint/suspicious/noExplicitAny: document OpenAPI brut (pas de type partagé côté test, structure vérifiée par assertions).
  let body: any

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    const res = await request(app.getHttpServer()).get('/openapi.json')
    expect(res.status).toBe(200)
    body = res.body
  })

  afterAll(async () => {
    await app.close()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('renvoie un document OpenAPI 3.1.x', () => {
    expect(body.openapi).toMatch(/^3\.1\.\d+$/)
  })

  it('info.title est « Factelec API publique », info.version == package.json', () => {
    expect(body.info.title).toBe('Factelec API publique')
    expect(body.info.version).toBe(EXPECTED_VERSION)
  })

  it('contient POST /invoices (dépôt) et GET /invoices/{id} (détail)', () => {
    expect(body.paths['/invoices']?.post).toBeTruthy()
    expect(body.paths['/invoices/{id}']?.get).toBeTruthy()
  })

  it('contient GET /invoices (liste), GET /invoices/{id}/formats/{format} et GET /invoices/{id}/status (statut CDV)', () => {
    expect(body.paths['/invoices']?.get).toBeTruthy()
    expect(body.paths['/invoices/{id}/formats/{format}']?.get).toBeTruthy()
    expect(body.paths['/invoices/{id}/status']?.get).toBeTruthy()
  })

  it('contient GET /health (santé publique)', () => {
    expect(body.paths['/health']?.get).toBeTruthy()
  })

  it('EXCLUT POST /invoices/{id}/status (SessionGuard seul, jamais clé API)', () => {
    expect(body.paths['/invoices/{id}/status']?.post).toBeUndefined()
  })

  it('EXCLUT /invoices/{id}/routing/resolve (hors périmètre connecteur it.1)', () => {
    expect(body.paths['/invoices/{id}/routing/resolve']).toBeUndefined()
  })

  it('ne contient AUCUN chemin /admin, /auth, /billing ou /metrics', () => {
    const paths = Object.keys(body.paths)
    expect(paths.length).toBeGreaterThan(0)
    const offenders = paths.filter((p) =>
      FORBIDDEN_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)),
    )
    expect(offenders).toEqual([])
  })
})
