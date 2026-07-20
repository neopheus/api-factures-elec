import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  buildReport,
  type QueryFn,
  type QueryResult,
  runChecks,
  type VerifyProvisioningDeps,
} from '../../scripts/verify-provisioning.js'

// Compte réel du journal Drizzle — lu depuis le même fichier que le script
// (pas dupliqué en dur : reste synchronisé automatiquement si une migration
// est ajoutée).
const JOURNAL_ENTRY_COUNT = (
  JSON.parse(
    readFileSync(
      new URL('../../src/db/migrations/meta/_journal.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: unknown[] }
).entries.length

const EXPECTED_ROLE_ROWS = [
  { rolname: 'factelec_owner', rolbypassrls: true },
  { rolname: 'factelec_app', rolbypassrls: false },
  { rolname: 'factelec_worker', rolbypassrls: false },
]

// Fabrique un routeur de requêtes SQL minimal : seules les formes de requête
// RÉELLEMENT émises par `runChecks` sont reconnues — fonction pure testée en
// isolation totale de Postgres, aucun besoin d'un vrai moteur.
function makeQueryApp(overrides: {
  pgcryptoRows?: QueryResult['rows']
  migrationsCount?: number
  rlsRows?: QueryResult['rows']
  grantedFunctionSignatures?: string[]
}): QueryFn {
  const {
    pgcryptoRows = [{ extname: 'pgcrypto' }],
    migrationsCount = JOURNAL_ENTRY_COUNT,
    rlsRows = [
      { relname: 'tenants', relforcerowsecurity: true },
      { relname: 'invoices', relforcerowsecurity: true },
      { relname: 'tenant_billing', relforcerowsecurity: true },
      { relname: 'platform_admins', relforcerowsecurity: true },
    ],
    grantedFunctionSignatures = [],
  } = overrides
  return vi.fn(
    async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      if (sql.includes('pg_extension')) {
        return { rows: pgcryptoRows }
      }
      if (sql.includes('__drizzle_migrations')) {
        return { rows: [{ count: migrationsCount }] }
      }
      if (sql.includes('pg_class')) {
        return { rows: rlsRows }
      }
      if (sql.includes('has_function_privilege')) {
        const signature = params?.[0] as string
        return {
          rows: [{ granted: grantedFunctionSignatures.includes(signature) }],
        }
      }
      throw new Error(`requête inattendue en test : ${sql}`)
    },
  )
}

function makeQueryOwner(
  roleRows: QueryResult['rows'] = EXPECTED_ROLE_ROWS,
): QueryFn {
  return vi.fn(async () => ({ rows: roleRows }))
}

function makeDeps(
  overrides: Partial<VerifyProvisioningDeps> & {
    queryAppOverrides?: Parameters<typeof makeQueryApp>[0]
  } = {},
): VerifyProvisioningDeps {
  const { queryAppOverrides, ...rest } = overrides
  return {
    queryApp: makeQueryApp(queryAppOverrides ?? {}),
    queryOwner: makeQueryOwner(),
    redisPing: vi.fn().mockResolvedValue(true),
    env: { DATABASE_URL: 'postgres://factelec_app:pw@localhost/factelec' },
    ...rest,
  }
}

describe('runChecks', () => {
  it('nominal : provisioning conforme → tous les contrôles ok:true, aucun skip', async () => {
    const deps = makeDeps()

    const results = await runChecks(deps)

    expect(results.length).toBeGreaterThan(0)
    for (const check of results) {
      expect(check.ok, `${check.name} : ${check.detail}`).toBe(true)
      expect(check.skipped).toBeFalsy()
    }
  })

  it('owner absent : les 3 contrôles de rôles sont SKIP, pas ÉCHEC', async () => {
    const deps = makeDeps({ queryOwner: undefined })

    const results = await runChecks(deps)

    const roleChecks = results.filter((r) => r.name.startsWith('rôles: '))
    expect(roleChecks).toHaveLength(3)
    for (const check of roleChecks) {
      expect(check.skipped).toBe(true)
      expect(check.ok).toBe(true)
    }
    const { exitCode } = buildReport(results)
    expect(exitCode).toBe(0)
  })

  it('rôle avec un mauvais rolbypassrls : échec nommé avec détail', async () => {
    const deps = makeDeps({
      queryOwner: makeQueryOwner([
        { rolname: 'factelec_owner', rolbypassrls: false }, // devrait être true
        { rolname: 'factelec_app', rolbypassrls: false },
        { rolname: 'factelec_worker', rolbypassrls: false },
      ]),
    })

    const results = await runChecks(deps)

    const ownerCheck = results.find((r) => r.name === 'rôles: factelec_owner')
    expect(ownerCheck?.ok).toBe(false)
    expect(ownerCheck?.detail).toContain('rolbypassrls=false')
  })

  it('pgcrypto absent : échec avec détail explicite', async () => {
    const deps = makeDeps({ queryAppOverrides: { pgcryptoRows: [] } })

    const results = await runChecks(deps)

    const check = results.find((r) => r.name === 'pgcrypto (extension)')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toMatch(/absente/)
  })

  it('migrations : count mismatch avec le journal → échec', async () => {
    const deps = makeDeps({
      queryAppOverrides: { migrationsCount: JOURNAL_ENTRY_COUNT - 1 },
    })

    const results = await runChecks(deps)

    const check = results.find((r) => r.name.startsWith('migrations ('))
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain(`attendu=${JOURNAL_ENTRY_COUNT}`)
  })

  it('migrations : count égal au journal → ok', async () => {
    const deps = makeDeps()

    const results = await runChecks(deps)

    const check = results.find((r) => r.name.startsWith('migrations ('))
    expect(check?.ok).toBe(true)
  })

  it('requête migrations en échec : échec avec le message d’erreur, pas de crash', async () => {
    const failingQueryApp: QueryFn = vi.fn(async (sql: string) => {
      if (sql.includes('__drizzle_migrations')) {
        throw new Error('drizzle schema inaccessible')
      }
      return { rows: [] }
    })
    const deps = makeDeps({ queryApp: failingQueryApp })

    const results = await runChecks(deps)

    const check = results.find((r) => r.name.startsWith('migrations ('))
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('drizzle schema inaccessible')
  })

  it('RLS FORCE désactivée sur une table de l’échantillon → échec nommé pour cette table', async () => {
    const deps = makeDeps({
      queryAppOverrides: {
        rlsRows: [
          { relname: 'tenants', relforcerowsecurity: true },
          { relname: 'invoices', relforcerowsecurity: false }, // désactivée
          { relname: 'tenant_billing', relforcerowsecurity: true },
          { relname: 'platform_admins', relforcerowsecurity: true },
        ],
      },
    })

    const results = await runChecks(deps)

    expect(results.find((r) => r.name === 'RLS FORCE: invoices')?.ok).toBe(
      false,
    )
    expect(results.find((r) => r.name === 'RLS FORCE: tenants')?.ok).toBe(true)
  })

  it('un SD auth/session/admin accordé au worker → échec nommé pour cette seule fonction', async () => {
    const deps = makeDeps({
      queryAppOverrides: {
        grantedFunctionSignatures: [
          'public.set_admin_recovery_codes(uuid, jsonb, jsonb)',
        ],
      },
    })

    const results = await runChecks(deps)

    const leaking = results.find((r) =>
      r.name.includes('set_admin_recovery_codes'),
    )
    expect(leaking?.ok).toBe(false)
    expect(leaking?.detail).toMatch(/FUITE/)

    // Les 12 autres fonctions de la liste restent conformes.
    const otherWorkerGrantChecks = results.filter(
      (r) =>
        r.name.startsWith('grants worker: ') &&
        !r.name.includes('set_admin_recovery_codes'),
    )
    expect(otherWorkerGrantChecks).toHaveLength(12)
    for (const check of otherWorkerGrantChecks) {
      expect(check.ok, check.name).toBe(true)
    }
  })

  it('exactement 13 contrôles de grants worker (les 13 SD auth/session/admin)', async () => {
    const deps = makeDeps()

    const results = await runChecks(deps)

    const workerGrantChecks = results.filter((r) =>
      r.name.startsWith('grants worker: '),
    )
    expect(workerGrantChecks).toHaveLength(13)
  })

  it('requête pg_roles en échec (owner présent) : les 3 contrôles échouent avec le message d’erreur', async () => {
    const deps = makeDeps({
      queryOwner: vi.fn().mockRejectedValue(new Error('connection refused')),
    })

    const results = await runChecks(deps)

    const roleChecks = results.filter((r) => r.name.startsWith('rôles: '))
    expect(roleChecks).toHaveLength(3)
    for (const check of roleChecks) {
      expect(check.ok).toBe(false)
      expect(check.skipped).toBeFalsy()
      expect(check.detail).toContain('connection refused')
    }
  })

  it('requête pgcrypto en échec : échec avec le message d’erreur, pas de crash', async () => {
    const failingQueryApp: QueryFn = vi
      .fn()
      .mockRejectedValue(new Error('pg_extension inaccessible'))
    const deps = makeDeps({ queryApp: failingQueryApp })

    const results = await runChecks(deps)

    const check = results.find((r) => r.name === 'pgcrypto (extension)')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('pg_extension inaccessible')
  })

  it('requête RLS en échec : les 4 tables de l’échantillon échouent avec le message d’erreur', async () => {
    const queryApp = makeQueryApp({})
    ;(queryApp as ReturnType<typeof vi.fn>).mockImplementation(
      async (sql: string) => {
        if (sql.includes('pg_class')) {
          throw new Error('pg_class inaccessible')
        }
        if (sql.includes('pg_extension'))
          return { rows: [{ extname: 'pgcrypto' }] }
        if (sql.includes('__drizzle_migrations')) {
          return { rows: [{ count: JOURNAL_ENTRY_COUNT }] }
        }
        return { rows: [{ granted: false }] }
      },
    )
    const deps = makeDeps({ queryApp })

    const results = await runChecks(deps)

    const rlsChecks = results.filter((r) => r.name.startsWith('RLS FORCE: '))
    expect(rlsChecks).toHaveLength(4)
    for (const check of rlsChecks) {
      expect(check.ok).toBe(false)
      expect(check.detail).toContain('pg_class inaccessible')
    }
  })

  it('requête grants worker en échec pour une seule fonction : échec isolé, les autres continuent', async () => {
    const queryApp = makeQueryApp({})
    ;(queryApp as ReturnType<typeof vi.fn>).mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_extension'))
          return { rows: [{ extname: 'pgcrypto' }] }
        if (sql.includes('__drizzle_migrations')) {
          return { rows: [{ count: JOURNAL_ENTRY_COUNT }] }
        }
        if (sql.includes('pg_class')) {
          return {
            rows: [
              { relname: 'tenants', relforcerowsecurity: true },
              { relname: 'invoices', relforcerowsecurity: true },
              { relname: 'tenant_billing', relforcerowsecurity: true },
              { relname: 'platform_admins', relforcerowsecurity: true },
            ],
          }
        }
        if (sql.includes('has_function_privilege')) {
          if (params?.[0] === 'public.find_session(text)') {
            throw new Error('has_function_privilege timeout')
          }
          return { rows: [{ granted: false }] }
        }
        throw new Error(`requête inattendue : ${sql}`)
      },
    )
    const deps = makeDeps({ queryApp })

    const results = await runChecks(deps)

    const failing = results.find((r) => r.name.includes('find_session'))
    expect(failing?.ok).toBe(false)
    expect(failing?.detail).toContain('has_function_privilege timeout')

    const others = results.filter(
      (r) =>
        r.name.startsWith('grants worker: ') &&
        !r.name.includes('find_session'),
    )
    expect(others).toHaveLength(12)
    for (const check of others) {
      expect(check.ok, check.name).toBe(true)
    }
  })

  it('Redis injoignable : échec avec détail', async () => {
    const deps = makeDeps({
      redisPing: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    })

    const results = await runChecks(deps)

    const check = results.find((r) => r.name === 'Redis ping')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('ECONNREFUSED')
  })

  it('Redis répond mais pas PONG : échec', async () => {
    const deps = makeDeps({ redisPing: vi.fn().mockResolvedValue(false) })

    const results = await runChecks(deps)

    expect(results.find((r) => r.name === 'Redis ping')?.ok).toBe(false)
  })

  it('DATABASE_URL absente de env : échec sans jamais exposer de valeur', async () => {
    const deps = makeDeps({ env: {} })

    const results = await runChecks(deps)

    const check = results.find((r) => r.name === 'env: DATABASE_URL')
    expect(check?.ok).toBe(false)
    expect(check?.detail).not.toMatch(/postgres:\/\//)
  })
})

describe('buildReport', () => {
  it('exit code 0 quand tout est ok/skip, 1 dès qu’un contrôle échoue', () => {
    const okOnly = buildReport([
      { name: 'a', ok: true },
      { name: 'b', ok: true, skipped: true },
    ])
    expect(okOnly.exitCode).toBe(0)

    const withFailure = buildReport([
      { name: 'a', ok: true },
      { name: 'b', ok: false, detail: 'boom' },
    ])
    expect(withFailure.exitCode).toBe(1)
  })

  it('formate chaque ligne avec le bon tag [OK]/[ÉCHEC]/[SKIP]', () => {
    const { lines } = buildReport([
      { name: 'a', ok: true, detail: 'fine' },
      { name: 'b', ok: false, detail: 'boom' },
      { name: 'c', ok: true, skipped: true, detail: 'sauté' },
    ])

    expect(lines.some((l) => l.startsWith('[OK] a — fine'))).toBe(true)
    expect(lines.some((l) => l.startsWith('[ÉCHEC] b — boom'))).toBe(true)
    expect(lines.some((l) => l.startsWith('[SKIP] c — sauté'))).toBe(true)
  })

  it("aucun secret n'apparaît jamais dans les lignes produites", async () => {
    const secretUrl =
      'postgres://factelec_app:tres-secret-motdepasse@db.example/factelec'
    const deps = makeDeps({ env: { DATABASE_URL: secretUrl } })

    const results = await runChecks(deps)
    const { lines } = buildReport(results)
    const report = lines.join('\n')

    expect(report).not.toContain('tres-secret-motdepasse')
    expect(report).not.toContain(secretUrl)
    // La longueur seule est autorisée à apparaître.
    expect(report).toContain(`longueur=${secretUrl.length}`)
  })
})
