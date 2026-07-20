import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Queue } from 'bullmq'
import pg from 'pg'

// Script de vérification post-provisioning (Task 3, plan phase 6 prep,
// runbook `docs/operations/runbook-provisioning-prod.md` §12) — READ-ONLY,
// aucune écriture, aucun secret imprimé. Calque `billing-bootstrap.ts` :
// logique pure exportée et testée (`runChecks`), `main()` se contente de
// construire les connexions réelles et d'imprimer.

// ── Types ────────────────────────────────────────────────────────────────

// Forme minimale d'un résultat de requête SQL — compatible `pg.Pool.query`
// SANS importer `pg` dans la logique pure (seul `main()` en a besoin).
export interface QueryResult {
  rows: Array<Record<string, unknown>>
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>

export interface VerifyProvisioningDeps {
  // Connexion applicative (DATABASE_URL) — TOUJOURS requise : le script
  // refuse de démarrer sans elle (même contrat que le process API).
  queryApp: QueryFn
  // Connexion owner (DATABASE_OWNER_URL) — OPTIONNELLE. Les contrôles qui en
  // dépendent (attributs des rôles, cf. `checkRoles` ci-dessous) sont SKIP,
  // JAMAIS ÉCHEC, quand elle est absente.
  queryOwner?: QueryFn
  redisPing: () => Promise<boolean>
  // `Record<string, string | undefined>` plutôt que `NodeJS.ProcessEnv` :
  // injectable tel quel depuis un objet littéral en test, sans dépendre du
  // global `process`.
  env: Record<string, string | undefined>
}

export interface CheckResult {
  name: string
  ok: boolean
  detail?: string
  skipped?: boolean
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Constantes de contrôle ──────────────────────────────────────────────

// Attributs attendus des 3 rôles applicatifs (`00-roles.sql`, README §Rôles
// Postgres) : SEUL `factelec_owner` a BYPASSRLS — c'est précisément ce qui
// lui permet de faire tourner les migrations/le provisioning hors RLS.
// `factelec_app`/`factelec_worker` ne l'ont JAMAIS (leur isolation tenant
// dépend de la RLS FORCE, cf. `RLS_FORCE_SAMPLE_TABLES` ci-dessous).
const EXPECTED_ROLE_BYPASSRLS: ReadonlyArray<{
  role: string
  bypassrls: boolean
}> = [
  { role: 'factelec_owner', bypassrls: true },
  { role: 'factelec_app', bypassrls: false },
  { role: 'factelec_worker', bypassrls: false },
]

// Échantillon de tables sensibles devant porter RLS FORCE (spec §4) — les 4
// citées explicitement par le design : 2 historiques (migration `0001`) +
// 2 plus récentes (`0030` billing, `0002`/`0003` auth admin).
const RLS_FORCE_SAMPLE_TABLES = [
  'tenants',
  'invoices',
  'tenant_billing',
  'platform_admins',
] as const

// Les 13 fonctions SECURITY DEFINER auth/session/admin — README §Rôles
// Postgres : "AUCUNE des 13 fonctions SECURITY DEFINER auth/session/admin"
// pour `factelec_worker`. Signatures exactes relevées dans les migrations
// `0001`/`0003`/`0009`/`0031`/`0032` (texte attendu par
// `has_function_privilege`, format `schema.fonction(types...)`).
//
// `purge_expired_sessions()` est VOLONTAIREMENT ABSENTE de cette liste :
// bien que "session" par le nom, c'est l'UNE des 9 fonctions de sweep
// légitimement accordées à `factelec_worker` (migration
// `0029_worker_role_grants.sql`, commentaire "9 SEULES fonctions SD
// réellement appelées par le worker") — l'inclure ferait échouer ce
// contrôle en permanence sur un provisioning pourtant conforme.
const FORBIDDEN_WORKER_FUNCTIONS: ReadonlyArray<{
  name: string
  signature: string
}> = [
  {
    name: 'authenticate_api_key',
    signature: 'public.authenticate_api_key(text)',
  },
  { name: 'authenticate_user', signature: 'public.authenticate_user(text)' },
  {
    name: 'authenticate_platform_admin',
    signature: 'public.authenticate_platform_admin(text)',
  },
  {
    name: 'signup_tenant',
    signature: 'public.signup_tenant(text, text, text, text)',
  },
  {
    name: 'create_session',
    signature:
      'public.create_session(uuid, uuid, uuid, text, text, timestamptz)',
  },
  { name: 'find_session', signature: 'public.find_session(text)' },
  { name: 'revoke_session', signature: 'public.revoke_session(text)' },
  {
    name: 'list_tenants_for_admin',
    signature: 'public.list_tenants_for_admin()',
  },
  {
    name: 'find_admin_tenant_stats',
    signature: 'public.find_admin_tenant_stats()',
  },
  {
    name: 'find_admin_anomalies',
    signature: 'public.find_admin_anomalies(integer)',
  },
  {
    name: 'set_admin_totp_secret_pending',
    signature: 'public.set_admin_totp_secret_pending(uuid, text)',
  },
  {
    name: 'confirm_admin_totp',
    signature: 'public.confirm_admin_totp(uuid, jsonb)',
  },
  {
    name: 'set_admin_recovery_codes',
    signature: 'public.set_admin_recovery_codes(uuid, jsonb, jsonb)',
  },
]

// Clés dont l'absence fait échouer `validateEnv()` (aucun `.default()` ni
// `.optional()` dans `envSchema`, `src/config/env.ts`) — SEULE façon fiable
// de savoir ce qui est réellement requis, plutôt qu'une liste maintenue à la
// main sans lien avec le schéma réel. Vérifié au 2026-07-20 : `DATABASE_URL`
// est la SEULE clé requise sans défaut ni `.optional()` — `SESSION_SECRET`
// n'existe PAS dans `env.ts` (rien à vérifier pour elle). Si `env.ts` gagne
// une nouvelle clé requise, CETTE LISTE DOIT ÊTRE MISE À JOUR.
const CRITICAL_ENV_KEYS = ['DATABASE_URL'] as const

// ── Contrôles individuels ───────────────────────────────────────────────

// Owner-only (spec §4) : `queryOwner` absente → les 3 contrôles sont SKIP,
// jamais ÉCHEC (le script reste utilisable avec le seul rôle applicatif).
async function checkRoles(queryOwner?: QueryFn): Promise<CheckResult[]> {
  if (!queryOwner) {
    return EXPECTED_ROLE_BYPASSRLS.map(({ role }) => ({
      name: `rôles: ${role}`,
      ok: true,
      skipped: true,
      detail: 'DATABASE_OWNER_URL absente — contrôle sauté',
    }))
  }
  try {
    const { rows } = await queryOwner(
      'SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
      [EXPECTED_ROLE_BYPASSRLS.map((r) => r.role)],
    )
    return EXPECTED_ROLE_BYPASSRLS.map(({ role, bypassrls }) => {
      const row = rows.find((r) => r.rolname === role)
      if (!row) {
        return {
          name: `rôles: ${role}`,
          ok: false,
          detail: 'rôle absent de pg_roles',
        }
      }
      const actual = Boolean(row.rolbypassrls)
      return {
        name: `rôles: ${role}`,
        ok: actual === bypassrls,
        detail: `rolbypassrls=${actual} (attendu ${bypassrls})`,
      }
    })
  } catch (err) {
    const detail = `requête pg_roles en échec : ${errMsg(err)}`
    return EXPECTED_ROLE_BYPASSRLS.map(({ role }) => ({
      name: `rôles: ${role}`,
      ok: false,
      detail,
    }))
  }
}

async function checkPgcrypto(queryApp: QueryFn): Promise<CheckResult> {
  const name = 'pgcrypto (extension)'
  try {
    const { rows } = await queryApp(
      "SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'",
    )
    const present = rows.length > 0
    return {
      name,
      ok: present,
      detail: present
        ? 'extension présente'
        : 'extension pgcrypto absente — requise (spec 2.2)',
    }
  } catch (err) {
    return { name, ok: false, detail: errMsg(err) }
  }
}

// Lit le nombre d'entrées du journal Drizzle DIRECTEMENT depuis le fichier
// versionné (`src/db/migrations/meta/_journal.json`) — pas injecté dans
// `deps` : c'est un artefact de dépôt déterministe, pas une dépendance
// environnementale (même posture que `METER_EVENT_NAME` en dur dans
// `billing-bootstrap.ts`).
function readJournalEntryCount(): number {
  const journalUrl = new URL(
    '../src/db/migrations/meta/_journal.json',
    import.meta.url,
  )
  const raw = readFileSync(journalUrl, 'utf8')
  const journal = JSON.parse(raw) as { entries: unknown[] }
  return journal.entries.length
}

async function checkMigrations(queryApp: QueryFn): Promise<CheckResult> {
  const name = 'migrations (drizzle.__drizzle_migrations == journal)'
  try {
    const expected = readJournalEntryCount()
    const { rows } = await queryApp(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
    )
    const actual = Number(rows[0]?.count ?? Number.NaN)
    return {
      name,
      ok: actual === expected,
      detail: `appliquées=${actual} attendu=${expected} (journal _journal.json)`,
    }
  } catch (err) {
    return { name, ok: false, detail: errMsg(err) }
  }
}

async function checkRlsForce(queryApp: QueryFn): Promise<CheckResult[]> {
  try {
    const { rows } = await queryApp(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [RLS_FORCE_SAMPLE_TABLES],
    )
    return RLS_FORCE_SAMPLE_TABLES.map((table) => {
      const row = rows.find((r) => r.relname === table)
      if (!row) {
        return {
          name: `RLS FORCE: ${table}`,
          ok: false,
          detail: 'table absente de pg_class',
        }
      }
      const forced = Boolean(row.relforcerowsecurity)
      return {
        name: `RLS FORCE: ${table}`,
        ok: forced,
        detail: forced
          ? 'relforcerowsecurity=true'
          : 'relforcerowsecurity=false — RLS non forcée',
      }
    })
  } catch (err) {
    const detail = errMsg(err)
    return RLS_FORCE_SAMPLE_TABLES.map((table) => ({
      name: `RLS FORCE: ${table}`,
      ok: false,
      detail,
    }))
  }
}

// Spot-check nommé par fonction (13 requêtes indépendantes plutôt qu'une
// seule combinée) : une fonction manquante (déploiement partiel) ne fait
// échouer QUE son propre contrôle, avec un détail exploitable — pas les 13
// d'un coup.
async function checkWorkerGrants(queryApp: QueryFn): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const fn of FORBIDDEN_WORKER_FUNCTIONS) {
    const name = `grants worker: EXECUTE ${fn.name} interdit`
    try {
      const { rows } = await queryApp(
        "SELECT has_function_privilege('factelec_worker', $1::regprocedure, 'EXECUTE') AS granted",
        [fn.signature],
      )
      const granted = Boolean(rows[0]?.granted)
      results.push({
        name,
        ok: !granted,
        detail: granted
          ? 'EXECUTE accordé à factelec_worker — FUITE (fonction SD auth/session/admin)'
          : 'EXECUTE non accordé (conforme)',
      })
    } catch (err) {
      results.push({ name, ok: false, detail: errMsg(err) })
    }
  }
  return results
}

async function checkRedis(
  redisPing: () => Promise<boolean>,
): Promise<CheckResult> {
  const name = 'Redis ping'
  try {
    const pong = await redisPing()
    return {
      name,
      ok: pong,
      detail: pong
        ? 'PONG reçu'
        : 'ping sans PONG — Redis joignable mais réponse inattendue',
    }
  } catch (err) {
    return { name, ok: false, detail: errMsg(err) }
  }
}

function checkEnv(env: Record<string, string | undefined>): CheckResult[] {
  return CRITICAL_ENV_KEYS.map((key) => {
    const value = env[key]
    const present = typeof value === 'string' && value.length > 0
    return {
      name: `env: ${key}`,
      ok: present,
      // Jamais la valeur elle-même — seule sa longueur (confidentialité).
      detail: present
        ? `présente (longueur=${value.length})`
        : 'absente ou vide',
    }
  })
}

// ── Orchestration (logique pure, testée) ────────────────────────────────

// Ordre de sortie calqué sur le déroulé du runbook (§12) : rôles → pgcrypto
// → migrations → RLS → grants worker → Redis → env.
export async function runChecks(
  deps: VerifyProvisioningDeps,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  results.push(...(await checkRoles(deps.queryOwner)))
  results.push(await checkPgcrypto(deps.queryApp))
  results.push(await checkMigrations(deps.queryApp))
  results.push(...(await checkRlsForce(deps.queryApp)))
  results.push(...(await checkWorkerGrants(deps.queryApp)))
  results.push(await checkRedis(deps.redisPing))
  results.push(...checkEnv(deps.env))
  return results
}

function formatLine(check: CheckResult): string {
  const tag = check.skipped ? '[SKIP]' : check.ok ? '[OK]' : '[ÉCHEC]'
  const detail = check.detail ? ` — ${check.detail}` : ''
  return `${tag} ${check.name}${detail}`
}

// Imprime le rapport (une ligne par contrôle + résumé) et renvoie le code de
// sortie attendu — séparé de `console.log` pour rester testable sans espionner
// la console (le test sur "aucun secret imprimé" espionne quand même
// `console.log`, cf. tests unit, mais la logique de calcul de l'exit code
// elle-même ne dépend pas de la console).
export function buildReport(results: CheckResult[]): {
  lines: string[]
  exitCode: number
} {
  const lines = results.map(formatLine)
  const failed = results.filter((r) => !r.ok && !r.skipped)
  const skipped = results.filter((r) => r.skipped)
  lines.push('')
  lines.push(
    `Résumé : ${results.length} contrôle(s), ${failed.length} échec(s), ${skipped.length} sauté(s).`,
  )
  return { lines, exitCode: failed.length > 0 ? 1 : 0 }
}

// ── main() — construction des dépendances RÉELLES uniquement ────────────

async function pingRedis(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  // Même façade que `health.controller.ts#checkRedis` : BullMQ 5.80.9 ne
  // déclare pas `ping` sur son type `RedisClient` (seules les commandes
  // qu'il utilise en interne le sont) mais la forwarde bien au client
  // ioredis réel sous-jacent — l'assertion ne change rien à l'exécution,
  // elle comble seulement ce trou de typage. Un `Queue` jetable (fermé juste
  // après) évite d'ajouter `ioredis` comme dépendance directe de ce paquet
  // (aujourd'hui seulement transitive via `bullmq`, non résolvable en
  // import direct sous l'isolation pnpm de ce dépôt).
  const queue = new Queue('verify-provisioning-ping', {
    connection: {
      host: env.REDIS_HOST ?? 'localhost',
      port: Number(env.REDIS_PORT ?? 6379),
      db: Number(env.REDIS_DB ?? 0),
      password: env.REDIS_PASSWORD,
      tls: env.REDIS_TLS === 'true' || env.REDIS_TLS === '1' ? {} : undefined,
    },
  })
  try {
    const client = await queue.client
    const pong = await (client as unknown as { ping(): Promise<string> }).ping()
    return pong === 'PONG'
  } finally {
    await queue.close()
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL manquant : impossible de lancer verify-provisioning.',
    )
  }
  const appPool = new pg.Pool({ connectionString: databaseUrl })
  const ownerUrl = process.env.DATABASE_OWNER_URL
  const ownerPool = ownerUrl
    ? new pg.Pool({ connectionString: ownerUrl })
    : undefined
  if (!ownerUrl) {
    console.warn(
      'AVERTISSEMENT : DATABASE_OWNER_URL absente — contrôles rôles SKIP (attributs BYPASSRLS non vérifiés).',
    )
  }

  try {
    const deps: VerifyProvisioningDeps = {
      queryApp: (sql, params) => appPool.query(sql, params),
      queryOwner: ownerPool
        ? (sql, params) => ownerPool.query(sql, params)
        : undefined,
      redisPing: () => pingRedis(process.env),
      env: process.env,
    }
    const results = await runChecks(deps)
    const { lines, exitCode } = buildReport(results)
    for (const line of lines) console.log(line)
    process.exitCode = exitCode
  } finally {
    await appPool.end()
    if (ownerPool) await ownerPool.end()
  }
}

// Le script ne s'exécute QUE lancé directement (`node --import tsx
// scripts/verify-provisioning.ts`) — jamais à l'import par les tests unit,
// qui n'exercent que `runChecks`/`buildReport` avec des deps mockées (motif
// `billing-bootstrap.ts`).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
